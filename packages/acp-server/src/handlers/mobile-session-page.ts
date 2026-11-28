import type { HrcRuntimeSnapshot, HrcSessionRecord } from 'hrc-core'
import type {
  SessionFacetsRequest,
  SessionFacetsResponse,
  SessionPageItem,
  SessionPageRequest,
  SessionPeerStatus,
} from 'hrc-sdk'

import type { AcpHrcClient, ResolvedAcpServerDeps } from '../deps.js'
import { badRequest } from '../http.js'
import { federatedSessionReadFromStatus, requireHrcClient } from './mobile-hrc.js'
import {
  type MobileEventMessage,
  type MobileSessionMode,
  type MobileSessionSummary,
  latestRuntimeForSession,
  modeForExecution,
  projectSession,
  sessionRef,
} from './mobile-session-projection.js'
import { pageItemDisposition } from './session-disposition.js'

const MOBILE_SESSION_PAGE_SIZE = 50

export type MobileSessionPageInfo = {
  nextCursor?: string | undefined
  localNodeId: string
  eventHighWater: Record<string, number>
  complete: boolean
  peerStatus: Record<string, string>
}

export type MobileSessionFacets = Omit<SessionFacetsResponse, 'peerStatus'> & {
  peerStatus: Record<string, string>
}

type MobileSessionPagePayload = {
  generatedAt: string
  sessions: MobileSessionSummary[]
  recentEventsBySession: Record<string, MobileEventMessage[]>
  pageInfo: MobileSessionPageInfo
  facets: MobileSessionFacets
}

function parseMobileSessionPageLimit(url: URL, parameter = 'limit'): number {
  const raw = url.searchParams.get(parameter)
  if (raw === null) return MOBILE_SESSION_PAGE_SIZE
  if (!/^\d+$/.test(raw)) {
    badRequest(`${parameter} must be an integer between 1 and ${MOBILE_SESSION_PAGE_SIZE}`)
  }
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MOBILE_SESSION_PAGE_SIZE) {
    badRequest(`${parameter} must be an integer between 1 and ${MOBILE_SESSION_PAGE_SIZE}`)
  }
  return parsed
}

function parseMobileSessionPageRequest(
  url: URL,
  options: { limitParameter?: string | undefined } = {}
): SessionPageRequest {
  const effectiveStatus = url.searchParams.get('effectiveStatus')?.trim() || undefined
  if (
    effectiveStatus !== undefined &&
    !['active', 'detached', 'inactive', 'stale'].includes(effectiveStatus)
  ) {
    badRequest('effectiveStatus is invalid')
  }
  const executionMode = url.searchParams.get('executionMode')?.trim() || undefined
  if (
    executionMode !== undefined &&
    !['headless', 'interactive', 'nonInteractive'].includes(executionMode)
  ) {
    badRequest('executionMode is invalid')
  }
  const nodeId = url.searchParams.get('nodeId')?.trim() || undefined
  const cursor = url.searchParams.get('cursor')?.trim() || undefined
  const q = url.searchParams.get('q')?.trim() || undefined
  const agentId = url.searchParams.get('agentId')?.trim() || undefined
  const projectId = url.searchParams.get('projectId')?.trim() || undefined
  const laneRef = url.searchParams.get('laneRef')?.trim() || undefined
  return {
    limit: parseMobileSessionPageLimit(url, options.limitParameter ?? 'limit'),
    ...(cursor !== undefined ? { cursor } : {}),
    ...(q !== undefined ? { q } : {}),
    ...(agentId !== undefined ? { agentId } : {}),
    ...(projectId !== undefined ? { projectId } : {}),
    ...(laneRef !== undefined ? { laneRef } : {}),
    ...(effectiveStatus !== undefined
      ? { effectiveStatus: effectiveStatus as SessionPageRequest['effectiveStatus'] }
      : {}),
    ...(executionMode !== undefined
      ? { executionMode: executionMode as SessionPageRequest['executionMode'] }
      : {}),
    ...(nodeId !== undefined ? { nodes: nodeId } : {}),
  }
}

function sessionFacetRequest(request: SessionPageRequest): SessionFacetsRequest {
  return {
    ...(request.q !== undefined ? { q: request.q } : {}),
    ...(request.agentId !== undefined ? { agentId: request.agentId } : {}),
    ...(request.projectId !== undefined ? { projectId: request.projectId } : {}),
    ...(request.laneRef !== undefined ? { laneRef: request.laneRef } : {}),
    ...(request.effectiveStatus !== undefined ? { effectiveStatus: request.effectiveStatus } : {}),
    ...(request.executionMode !== undefined ? { executionMode: request.executionMode } : {}),
    ...(request.nodes !== undefined ? { nodes: request.nodes } : {}),
  }
}

function flattenPeerStatus(status: Record<string, SessionPeerStatus>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(status).map(([nodeId, observation]) => [nodeId, observation.state])
  )
}

function peerProjectionState(
  status: SessionPeerStatus | undefined
): MobileSessionSummary['projectionState'] {
  if (status === undefined || status.state === 'healthy') return 'answered'
  return status.state === 'invalid-response' ? 'invalid_response' : status.state
}

function projectThinIndexedSession(input: {
  item: SessionPageItem
  localNodeId: string
  peerStatus: Record<string, SessionPeerStatus>
  federatedRead: boolean
}): MobileSessionSummary {
  const { item } = input
  const isLocal = item.nodeId === input.localNodeId
  const readable = isLocal || input.federatedRead
  const peer = input.peerStatus[item.nodeId]
  const mode: MobileSessionMode = modeForExecution(item.executionMode)
  return {
    nodeId: item.nodeId,
    sourceKind: isLocal ? 'local_session' : 'remote_runtime_projection',
    ...(!isLocal
      ? {
          projectionState: peerProjectionState(peer),
          ...(peer?.checkedAt !== undefined ? { projectionCheckedAt: peer.checkedAt } : {}),
          ...(peer?.state === 'healthy' && peer.checkedAt !== undefined
            ? { projectionAnsweredAt: peer.checkedAt }
            : {}),
        }
      : {}),
    sessionRef: sessionRef(item.scopeRef, item.laneRef),
    displayRef: sessionRef(item.scopeRef, item.laneRef),
    title: item.agentId,
    mode,
    executionMode: item.executionMode,
    summaryStatus: item.effectiveStatus,
    status: item.effectiveStatus,
    ...pageItemDisposition(item),
    hostSessionId: item.hostSessionId,
    generation: item.generation,
    lastHrcSeq: 0,
    lastMessageSeq: 0,
    lastActivityAt: item.lastActivityAt,
    capabilities: {
      input: false,
      interrupt: false,
      launchHeadlessTurn: false,
      history: readable,
      summary: true,
      semanticDm: true,
      timeline: readable,
      literalInput: false,
      answerPrompt: isLocal,
    },
    session: {
      status: item.effectiveStatus,
      generation: item.generation,
      createdAt: item.createdAt,
      updatedAt: item.lastActivityAt,
    },
  }
}

type LocalSessionInputs = { record: HrcSessionRecord; runtimes: HrcRuntimeSnapshot[] }

/**
 * One session read and one runtime read for every local item on the page.
 * They replaced a by-host read and a runtime list per item, which made one
 * page cost HRC about 100 calls (EN-65215). Results are keyed by
 * hostSessionId, so a stray row can't land on another item. A failed session
 * read leaves every item thin, and a failed runtime read leaves them without
 * a runtime, as a failed per-item read did.
 */
async function readLocalSessionInputs(
  hrcClient: AcpHrcClient,
  hostSessionIds: string[]
): Promise<Map<string, LocalSessionInputs>> {
  const inputs = new Map<string, LocalSessionInputs>()
  if (hostSessionIds.length === 0) return inputs
  if (
    hrcClient.readSessionsByHostSessionIds === undefined ||
    hrcClient.readRuntimesByHostSessionIds === undefined
  ) {
    throw new Error('Installed HRC client does not expose batch session reads.')
  }
  const [sessionsResult, runtimesResult] = await Promise.allSettled([
    hrcClient.readSessionsByHostSessionIds(hostSessionIds),
    hrcClient.readRuntimesByHostSessionIds(hostSessionIds),
  ])
  if (sessionsResult.status !== 'fulfilled') return inputs
  const runtimesByHost = new Map<string, HrcRuntimeSnapshot[]>()
  if (runtimesResult.status === 'fulfilled') {
    for (const runtime of runtimesResult.value) {
      const bucket = runtimesByHost.get(runtime.hostSessionId)
      if (bucket === undefined) runtimesByHost.set(runtime.hostSessionId, [runtime])
      else bucket.push(runtime)
    }
  }
  const wanted = new Set(hostSessionIds)
  for (const item of sessionsResult.value) {
    if ('error' in item || !wanted.has(item.hostSessionId)) continue
    inputs.set(item.hostSessionId, {
      record: item,
      runtimes: runtimesByHost.get(item.hostSessionId) ?? [],
    })
  }
  return inputs
}

function projectIndexedSession(input: {
  item: SessionPageItem
  localNodeId: string
  peerStatus: Record<string, SessionPeerStatus>
  federatedRead: boolean
  local: LocalSessionInputs | undefined
}): MobileSessionSummary {
  const thin = projectThinIndexedSession(input)
  if (input.item.nodeId !== input.localNodeId || input.local === undefined) return thin

  const { record } = input.local
  const runtime = latestRuntimeForSession(record, input.local.runtimes)
  const projected = projectSession({ record, runtime })
  return {
    ...projected,
    nodeId: input.item.nodeId,
    sourceKind: 'local_session',
    mode: modeForExecution(input.item.executionMode, runtime),
    executionMode: input.item.executionMode,
    summaryStatus: input.item.effectiveStatus,
    status: input.item.effectiveStatus,
    ...pageItemDisposition(input.item),
    lastActivityAt: input.item.lastActivityAt,
  }
}

// Facets count the whole filtered set, so they do not change between pages of
// one listing. HRC facets fan out to every federation peer; re-reading them on
// each cursor page made a paged scan pay that fan-out once per page.
const FACETS_REUSE_TTL_MS = 30_000
const facetsByClient = new WeakMap<
  object,
  Map<string, { atMs: number; facets: SessionFacetsResponse }>
>()

async function sessionFacetsForPage(
  hrcClient: AcpHrcClient,
  getSessionFacets: NonNullable<AcpHrcClient['getSessionFacets']>,
  request: SessionPageRequest
): Promise<SessionFacetsResponse> {
  const facetRequest = sessionFacetRequest(request)
  const key = JSON.stringify(facetRequest)
  let cache = facetsByClient.get(hrcClient)
  if (cache === undefined) {
    cache = new Map()
    facetsByClient.set(hrcClient, cache)
  }
  const cached = cache.get(key)
  if (
    request.cursor !== undefined &&
    cached !== undefined &&
    Date.now() - cached.atMs < FACETS_REUSE_TTL_MS
  ) {
    return cached.facets
  }
  const facets = await getSessionFacets(facetRequest)
  cache.delete(key)
  cache.set(key, { atMs: Date.now(), facets })
  while (cache.size > 64) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
  return facets
}

export async function loadMobileSessionPage(
  deps: ResolvedAcpServerDeps,
  url: URL,
  options: { limitParameter?: string | undefined } = {}
): Promise<MobileSessionPagePayload> {
  const hrcClient = requireHrcClient(deps)
  if (hrcClient.listSessionsPage === undefined || hrcClient.getSessionFacets === undefined) {
    throw new Error('Installed HRC does not expose paginated session index APIs.')
  }
  const request = parseMobileSessionPageRequest(url, options)
  const [page, facets, status] = await Promise.all([
    hrcClient.listSessionsPage(request),
    sessionFacetsForPage(hrcClient, hrcClient.getSessionFacets.bind(hrcClient), request),
    hrcClient.getStatus({ includeSessions: false }),
  ])
  const localNodeId = status.node.nodeId
  const federatedRead = federatedSessionReadFromStatus(status)
  const seen = new Set<string>()
  const items = page.items.filter((item) => {
    const key = `${item.nodeId}\u0000${item.hostSessionId}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  const local = await readLocalSessionInputs(
    hrcClient,
    items.filter((item) => item.nodeId === localNodeId).map((item) => item.hostSessionId)
  )
  const sessions = items.map((item) =>
    projectIndexedSession({
      item,
      localNodeId,
      peerStatus: page.peerStatus,
      federatedRead,
      local: local.get(item.hostSessionId),
    })
  )
  return {
    generatedAt: new Date().toISOString(),
    sessions,
    recentEventsBySession: {},
    pageInfo: {
      ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
      localNodeId,
      eventHighWater: page.eventHighWater,
      complete: page.complete,
      peerStatus: flattenPeerStatus(page.peerStatus),
    },
    facets: {
      total: facets.total,
      byEffectiveStatus: facets.byEffectiveStatus,
      byExecutionMode: facets.byExecutionMode,
      byAgentId: facets.byAgentId,
      byNodeId: facets.byNodeId,
      complete: facets.complete,
      peerStatus: flattenPeerStatus(facets.peerStatus),
    },
  }
}
