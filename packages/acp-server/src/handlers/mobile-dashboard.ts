import type { HrcLifecycleEvent, HrcRunRecord, HrcSessionRecord } from 'hrc-core'
import type { AcpHrcClient, ResolvedAcpServerDeps } from '../deps.js'
import { json } from '../http.js'
import type { RouteHandler } from '../routing/route-context.js'
import {
  type DashboardSessionRefresher,
  createDashboardSessionRefresher,
  sharedDashboardSessionReads,
} from './dashboard-session-refresh.js'
import { latestHrcSeq, listCachedLatestEventBySession } from './hrc-event-read-window.js'
import {
  type MobileFederationSnapshot,
  type MobileNodeState,
  buildMobileFederationSnapshot,
  thinLocalSessionForFederation,
} from './mobile-dashboard-federation.js'
import { requireHrcClient } from './mobile-hrc.js'
import {
  type MobileSessionFacets,
  type MobileSessionPageInfo,
  loadMobileSessionPage,
} from './mobile-session-page.js'
import {
  type MobileEventMessage,
  type MobileSessionSummary,
  latestRuntimeForSession,
  projectEvent,
  projectSession,
} from './mobile-session-projection.js'
import {
  type MobileWebSocketLike,
  parseMobileRawFlag,
  parseMobileSessionDetailsFlag,
  sendMobileErrorEnvelope,
  sendMobileJsonEnvelope,
} from './mobile-ws.js'
import { recordDisposition } from './session-disposition.js'

const DEFAULT_DASHBOARD_RECENT_EVENTS_PER_SESSION = 5
const MAX_DASHBOARD_RECENT_EVENTS_PER_SESSION = 10
const MAX_DASHBOARD_SNAPSHOT_EVENTS = 200
const MAX_MOBILE_SESSION_RUNS = 10_000
const MOBILE_DASHBOARD_RECENCY_MS = 24 * 60 * 60 * 1000
const DEFAULT_DASHBOARD_MAX_REPLAY_EVENTS = 10_000
const DEFAULT_DASHBOARD_MAX_REPLAY_AGE_MS = 3_600_000
const MOBILE_WS_PING_INTERVAL_MS = 30_000

type MobileDashboardSnapshot = {
  type: 'dashboard_snapshot'
  generatedAt: string
  cursors: {
    lastHrcSeq: number
    lastStreamSeq: number
    nextFromHrcSeq: number
  }
  sessions: MobileSessionSummary[]
  recentEventsBySession: Record<string, MobileEventMessage[]>
  pageInfo?: MobileSessionPageInfo | undefined
  facets?: MobileSessionFacets | undefined
}

type MobileDashboardSessionsRefreshed = {
  type: 'sessions_refreshed'
  generatedAt: string
  cursors: MobileDashboardSnapshot['cursors']
  sessions: MobileSessionSummary[]
}

function latestRunBySession(
  records: HrcSessionRecord[],
  runs: HrcRunRecord[]
): Map<string, HrcRunRecord> {
  const wanted = new Set(records.map((record) => sessionGenerationKey(record)))
  const bySession = new Map<string, HrcRunRecord>()
  for (const run of runs) {
    const key = sessionGenerationKey(run)
    if (!wanted.has(key) || bySession.has(key)) continue
    bySession.set(key, run)
  }
  return bySession
}

async function collectEvents(
  hrcClient: AcpHrcClient,
  options: Parameters<AcpHrcClient['watch']>[0],
  limit: number
): Promise<HrcLifecycleEvent[]> {
  const events: HrcLifecycleEvent[] = []
  for await (const event of hrcClient.watch(options)) {
    events.push(event)
    if (events.length >= limit) break
  }
  return events
}

async function listMobileSessions(
  deps: ResolvedAcpServerDeps,
  url: URL
): Promise<MobileSessionSummary[]> {
  const hrcClient = requireHrcClient(deps)
  const scopeRef = url.searchParams.get('scopeRef') ?? undefined
  const laneRef = url.searchParams.get('laneRef') ?? undefined
  const mode = url.searchParams.get('mode')
  const status = url.searchParams.get('status')
  const query = url.searchParams.get('q')?.trim().toLowerCase()
  const raw = parseMobileRawFlag(url)
  const includeSessionDetails = parseMobileSessionDetailsFlag(url)

  const [records, runtimes, latestEvents] = await Promise.all([
    // T-10833 (Lance ruling): the dashboard shows seats with a live runtime OR
    // activity in the last 24h, latest generation per seat (HRC `updatedSince` +
    // `latestGeneration`).
    hrcClient.listSessions({
      ...(scopeRef !== undefined ? { scopeRef } : {}),
      ...(laneRef !== undefined ? { laneRef } : {}),
      updatedSince: new Date(Date.now() - MOBILE_DASHBOARD_RECENCY_MS).toISOString(),
      latestGeneration: true,
    }),
    hrcClient.listRuntimes({}),
    // This HRC query groups over the event store. Coalesce concurrent dashboard
    // reads and retain it briefly rather than rerunning it for every request.
    listCachedLatestEventBySession(hrcClient, {
      ...(scopeRef !== undefined ? { scopeRef } : {}),
      ...(laneRef !== undefined ? { laneRef } : {}),
    }),
  ])
  const latestRuns = latestRunBySession(
    records,
    await hrcClient.listRuns({
      limit: Math.min(MAX_MOBILE_SESSION_RUNS, Math.max(100, records.length * 4)),
    })
  )

  const latestEventByHostSessionGeneration = new Map<string, HrcLifecycleEvent>()
  for (const event of latestEvents) {
    const key = sessionGenerationKey(event)
    latestEventByHostSessionGeneration.set(key, event)
  }

  let sessions = records.map((record) => {
    const generationKey = sessionGenerationKey(record)
    return projectSession({
      record,
      runtime: latestRuntimeForSession(record, runtimes),
      run: latestRuns.get(generationKey),
      lastEvent: latestEventByHostSessionGeneration.get(generationKey),
      raw,
      includeSessionDetails,
    })
  })

  if (mode === 'interactive' || mode === 'headless') {
    sessions = sessions.filter((session) => session.mode === mode)
  }
  if (status === 'active' || status === 'stale' || status === 'inactive' || status === 'detached') {
    sessions = sessions.filter((session) => session.summaryStatus === status)
  }
  if (query !== undefined && query.length > 0) {
    sessions = sessions.filter((session) =>
      [
        session.sessionRef,
        session.displayRef,
        session.title,
        session.hostSessionId,
        session.runtimeId ?? '',
        session.activeTurnId ?? '',
      ]
        .join(' ')
        .toLowerCase()
        .includes(query)
    )
  }

  sessions.sort((lhs, rhs) => (rhs.lastActivityAt ?? '').localeCompare(lhs.lastActivityAt ?? ''))
  return sessions
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function parseDashboardRecentEventsPerSession(url: URL): number {
  const parsed = Number.parseInt(url.searchParams.get('recentEventsPerSession') ?? '', 10)
  if (!Number.isFinite(parsed)) return DEFAULT_DASHBOARD_RECENT_EVENTS_PER_SESSION
  return Math.max(0, Math.min(MAX_DASHBOARD_RECENT_EVENTS_PER_SESSION, parsed))
}

function parseDashboardReplayCursor(url: URL): number | undefined {
  if (!url.searchParams.has('fromHrcSeq')) return undefined
  const parsed = Number.parseInt(url.searchParams.get('fromHrcSeq') ?? '', 10)
  return Number.isFinite(parsed) ? Math.max(1, parsed) : 1
}

function sessionGenerationKey(input: {
  hostSessionId?: string | undefined
  generation?: number | undefined
}): string {
  return `${input.hostSessionId}:${input.generation}`
}

function snapshotRecentStartSeq(lastHrcSeq: number): number {
  return Math.max(1, lastHrcSeq - MAX_DASHBOARD_SNAPSHOT_EVENTS + 1)
}

function pushBoundedRecentEvent(
  target: Record<string, MobileEventMessage[]>,
  event: MobileEventMessage,
  perSessionLimit: number
): void {
  if (event.hostSessionId === undefined || event.generation === undefined) return
  if (perSessionLimit <= 0) return
  const key = sessionGenerationKey(event)
  const bucket = target[key] ?? []
  bucket.push(event)
  if (bucket.length > perSessionLimit) bucket.splice(0, bucket.length - perSessionLimit)
  target[key] = bucket
}

async function buildMobileDashboardSnapshot(
  deps: ResolvedAcpServerDeps,
  url: URL
): Promise<MobileDashboardSnapshot> {
  const hrcClient = requireHrcClient(deps)
  const scopeRef = url.searchParams.get('scopeRef') ?? undefined
  const laneRef = url.searchParams.get('laneRef') ?? undefined
  const recentEventsPerSession = parseDashboardRecentEventsPerSession(url)
  const usesPaginatedIndex = url.pathname === '/v2/mobile/dashboard'

  const page = usesPaginatedIndex
    ? await loadMobileSessionPage(deps, url, { limitParameter: 'sessionLimit' })
    : undefined
  const sessions = page?.sessions ?? (await listMobileSessions(deps, url))
  const latestEvents = usesPaginatedIndex
    ? []
    : await listCachedLatestEventBySession(hrcClient, {
        ...(scopeRef !== undefined ? { scopeRef } : {}),
        ...(laneRef !== undefined ? { laneRef } : {}),
      })
  const lastHrcSeq =
    page !== undefined
      ? (page.pageInfo.eventHighWater[page.pageInfo.localNodeId] ?? 0)
      : latestHrcSeq(latestEvents)
  let lastStreamSeq = latestEvents.reduce((max, event) => Math.max(max, event.streamSeq), 0)
  const recentEventsBySession: Record<string, MobileEventMessage[]> = {}
  const wantedSessionKeys = new Set(sessions.map((session) => sessionGenerationKey(session)))

  if (lastHrcSeq > 0 && recentEventsPerSession > 0) {
    const recentEvents = await collectEvents(
      hrcClient,
      {
        fromSeq: snapshotRecentStartSeq(lastHrcSeq),
        follow: false,
        ...(scopeRef !== undefined ? { scopeRef } : {}),
        ...(laneRef !== undefined ? { laneRef } : {}),
      },
      MAX_DASHBOARD_SNAPSHOT_EVENTS
    )
    for (const event of recentEvents) {
      // The page high-water is captured before its rows. Events after it must
      // flow through the live watch so their matching row update is not lost.
      if (event.hrcSeq > lastHrcSeq) continue
      lastStreamSeq = Math.max(lastStreamSeq, event.streamSeq)
      if (
        event.hostSessionId === undefined ||
        event.generation === undefined ||
        !wantedSessionKeys.has(sessionGenerationKey(event))
      ) {
        continue
      }
      pushBoundedRecentEvent(recentEventsBySession, projectEvent(event), recentEventsPerSession)
    }
  }

  return {
    type: 'dashboard_snapshot',
    generatedAt: new Date().toISOString(),
    cursors: {
      lastHrcSeq,
      lastStreamSeq,
      nextFromHrcSeq: lastHrcSeq + 1,
    },
    sessions,
    recentEventsBySession,
    ...(page !== undefined ? { pageInfo: page.pageInfo, facets: page.facets } : {}),
  }
}

async function buildIndexedFederationSnapshot(
  hrcClient: AcpHrcClient,
  snapshot: MobileDashboardSnapshot
): Promise<MobileFederationSnapshot> {
  const generatedAt = snapshot.generatedAt
  const localNodeId = (await hrcClient.getStatus({ includeSessions: false })).node.nodeId
  const peerStatus = snapshot.pageInfo?.peerStatus ?? {}
  const nodeIds = new Set([
    ...Object.keys(snapshot.facets?.byNodeId ?? {}),
    ...Object.keys(peerStatus),
    localNodeId,
  ])
  return {
    type: 'federation_snapshot',
    generatedAt,
    localNodeId,
    nodes: [...nodeIds]
      .sort((lhs, rhs) => lhs.localeCompare(rhs))
      .map((nodeId) => {
        const rawState = nodeId === localNodeId ? 'healthy' : peerStatus[nodeId]
        const state: MobileNodeState =
          rawState === 'refused' || rawState === 'unreachable' || rawState === 'invalid_response'
            ? rawState
            : 'healthy'
        return {
          nodeId,
          state,
          checkedAt: generatedAt,
          ...(state === 'healthy' ? { answeredAt: generatedAt } : {}),
          latencyMs: 0,
        }
      }),
    sessions: [],
  }
}

async function validateMobileDashboardReplayCursor(input: {
  hrcClient: AcpHrcClient
  fromHrcSeq: number
  snapshotLastHrcSeq: number
}): Promise<string | undefined> {
  const maxReplayEvents = readPositiveIntegerEnv(
    'ACP_MOBILE_DASHBOARD_MAX_REPLAY_EVENTS',
    DEFAULT_DASHBOARD_MAX_REPLAY_EVENTS
  )
  const maxReplayAgeMs = readPositiveIntegerEnv(
    'ACP_MOBILE_DASHBOARD_MAX_REPLAY_AGE_MS',
    DEFAULT_DASHBOARD_MAX_REPLAY_AGE_MS
  )
  const replayCount = Math.max(0, input.snapshotLastHrcSeq - input.fromHrcSeq + 1)
  if (replayCount > maxReplayEvents) {
    return `Replay cursor is ${replayCount} events behind; reconnect without fromHrcSeq.`
  }

  const [firstReplayEvent] = await collectEvents(
    input.hrcClient,
    { fromSeq: input.fromHrcSeq, follow: false },
    1
  )
  if (firstReplayEvent !== undefined) {
    const replayAgeMs = Date.now() - Date.parse(firstReplayEvent.ts)
    if (Number.isFinite(replayAgeMs) && replayAgeMs > maxReplayAgeMs) {
      return `Replay cursor is older than ${maxReplayAgeMs}ms; reconnect without fromHrcSeq.`
    }
  }

  return undefined
}

function sendDashboardProjectedEvent(input: {
  ws: MobileWebSocketLike
  event: HrcLifecycleEvent
  seenHrcSeqs: Set<number>
  refresher: DashboardSessionRefresher
}): void {
  if (input.seenHrcSeqs.has(input.event.hrcSeq)) return
  input.seenHrcSeqs.add(input.event.hrcSeq)
  sendMobileJsonEnvelope(input.ws, projectEvent(input.event))
  input.refresher.note(input.event)
}

export async function openMobileDashboardWebSocket(
  ws: MobileWebSocketLike,
  hrcClient: AcpHrcClient,
  parsedURL: URL,
  fallbackNodeId: string
): Promise<void> {
  const { deps, abortController } = ws.data
  const raw = parseMobileRawFlag(parsedURL)
  const includeSessionDetails = parseMobileSessionDetailsFlag(parsedURL)
  const fromHrcSeq = parseDashboardReplayCursor(parsedURL)
  const builtSnapshot = await buildMobileDashboardSnapshot(deps, parsedURL)
  const snapshot: MobileDashboardSnapshot =
    ws.data.version === 2 && builtSnapshot.pageInfo === undefined
      ? { ...builtSnapshot, sessions: builtSnapshot.sessions.map(thinLocalSessionForFederation) }
      : builtSnapshot

  if (fromHrcSeq !== undefined) {
    const replayError = await validateMobileDashboardReplayCursor({
      hrcClient,
      fromHrcSeq,
      snapshotLastHrcSeq: snapshot.cursors.lastHrcSeq,
    })
    if (replayError !== undefined) {
      sendMobileErrorEnvelope(ws, 'replay_gap_too_large', replayError)
      ws.close(1008, 'replay gap too large')
      return
    }
  }

  sendMobileJsonEnvelope(ws, snapshot)
  if (ws.data.version === 1) {
    const sessionsRefreshed: MobileDashboardSessionsRefreshed = {
      type: 'sessions_refreshed',
      generatedAt: snapshot.generatedAt,
      cursors: snapshot.cursors,
      sessions: snapshot.sessions,
    }
    sendMobileJsonEnvelope(ws, sessionsRefreshed)
  } else {
    sendMobileJsonEnvelope(
      ws,
      snapshot.pageInfo !== undefined
        ? await buildIndexedFederationSnapshot(hrcClient, snapshot)
        : await buildMobileFederationSnapshot(hrcClient, fallbackNodeId)
    )
  }

  const seenHrcSeqs = new Set<number>()
  for (const events of Object.values(snapshot.recentEventsBySession)) {
    for (const event of events) {
      seenHrcSeqs.add(event.hrcSeq)
    }
  }

  const pingTimer = setInterval(() => {
    if (!abortController.signal.aborted) {
      sendMobileJsonEnvelope(ws, { type: 'ping', ts: new Date().toISOString() })
    }
  }, MOBILE_WS_PING_INTERVAL_MS)
  abortController.signal.addEventListener('abort', () => clearInterval(pingTimer), { once: true })

  // A failed refresh read ends the socket the way a failed per-event read did:
  // abort the watch, then rethrow so the listener closes with 1011.
  let refreshError: unknown
  const refresher = createDashboardSessionRefresher({
    reads: sharedDashboardSessionReads(hrcClient),
    signal: abortController.signal,
    onRefresh: async (latest, inputs) => {
      if (inputs === undefined) return
      const runtime = latestRuntimeForSession(inputs.record, inputs.runtimes)
      const session = projectSession({
        record: inputs.record,
        runtime,
        run: inputs.run ?? undefined,
        lastEvent: inputs.lastEvent ?? latest,
        raw,
        includeSessionDetails,
      })
      const disposition = await recordDisposition(hrcClient, inputs.record, session, runtime)
      sendMobileJsonEnvelope(ws, {
        type: 'session_updated',
        generatedAt: new Date().toISOString(),
        hrcSeq: latest.hrcSeq,
        session: { ...session, ...disposition },
      })
    },
    onError: (error) => {
      refreshError = error
      abortController.abort()
    },
  })

  try {
    if (fromHrcSeq !== undefined && fromHrcSeq <= snapshot.cursors.lastHrcSeq) {
      for await (const event of hrcClient.watch({
        fromSeq: fromHrcSeq,
        follow: false,
        signal: abortController.signal,
      })) {
        if (abortController.signal.aborted || event.hrcSeq > snapshot.cursors.lastHrcSeq) break
        sendDashboardProjectedEvent({ ws, event, seenHrcSeqs, refresher })
      }
    }

    for await (const event of hrcClient.watch({
      fromSeq: snapshot.cursors.nextFromHrcSeq,
      follow: true,
      signal: abortController.signal,
    })) {
      if (abortController.signal.aborted) break
      sendDashboardProjectedEvent({ ws, event, seenHrcSeqs, refresher })
    }
    await refresher.drain()
  } catch (error) {
    throw refreshError ?? error
  } finally {
    clearInterval(pingTimer)
  }
  if (refreshError !== undefined) throw refreshError
}

export const handleMobileDashboard: RouteHandler = async () =>
  json(
    {
      ok: false,
      code: 'upgrade_required',
      message: 'Use a WebSocket upgrade for /v1/mobile/dashboard.',
    },
    426
  )
