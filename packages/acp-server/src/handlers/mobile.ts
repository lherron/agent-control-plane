import { formatScopeHandle, parseScopeRef } from 'agent-scope'
import type {
  FederationNodeRuntimeProjection,
  FederationPeerHealthObservation,
  FederationRuntimeProjectionReport,
  HrcLifecycleEvent,
  HrcMessageAddress,
  HrcMessageFilter,
  HrcRunRecord,
  HrcRuntimeSnapshot,
  HrcSessionRecord,
  HrcTargetView,
} from 'hrc-core'
import { splitSessionRef } from 'hrc-core'
import type {
  SessionFacetsRequest,
  SessionFacetsResponse,
  SessionPageItem,
  SessionPageRequest,
  SessionPeerStatus,
} from 'hrc-sdk'
import { type CollaborationMessage, formatCollaborationMessage } from 'wrkq-lib'

import { badRequest, json } from '../http.js'
import { mobileUnauthorizedResponse } from '../mobile-auth/gate.js'
import {
  isRecord,
  parseJsonBody,
  readOptionalTrimmedStringField,
  requireRecord,
  requireTrimmedStringField,
} from '../parsers/body.js'
import { isLoopbackPeer } from '../routing/peer.js'

import type { AcpHrcClient, ResolvedAcpServerDeps } from '../deps.js'
import type { RouteHandler } from '../routing/route-context.js'
import { latestHrcSeq, listCachedLatestEventBySession } from './hrc-event-read-window.js'
import {
  type MobileWebSocketLike,
  abortMobileWebSocket,
  parseMobileEventCursor,
  parseMobileMessageCursor,
  parseMobileRawFlag,
  sendMobileErrorEnvelope,
  sendMobileJsonEnvelope,
} from './mobile-ws.js'

const GATEWAY_ID = 'acp-local'
const API_VERSION = 'v1'
const DEFAULT_BASE_URL = 'http://127.0.0.1:18470'
const DEFAULT_DASHBOARD_RECENT_EVENTS_PER_SESSION = 5
const MOBILE_SESSION_PAGE_SIZE = 50
const MAX_DASHBOARD_RECENT_EVENTS_PER_SESSION = 10
const MAX_DASHBOARD_SNAPSHOT_EVENTS = 200
const MAX_MOBILE_SESSION_RUNS = 10_000
const DEFAULT_DASHBOARD_MAX_REPLAY_EVENTS = 10_000
const DEFAULT_DASHBOARD_MAX_REPLAY_AGE_MS = 3_600_000
const MOBILE_WS_PING_INTERVAL_MS = 30_000
const MOBILE_COLLABORATION_MATCH_WINDOW_MS = 120_000
const HUMAN_COLLABORATION_PRINCIPAL = 'agent:lance'
const MOBILE_SESSION_DETAILS_QUERY_PARAM = 'sessionDetails'
const REMOTE_CONTROL_UNAVAILABLE_MESSAGE =
  'Remote timeline, history, literal input, and interrupt are unavailable in mobile federation Phase 1.'

type MobileSessionMode = 'interactive' | 'headless'
type MobileSessionStatus = 'active' | 'stale' | 'inactive' | 'detached'
type MobileExecutionMode = 'interactive' | 'headless' | 'nonInteractive'
type MobileSessionSourceKind = 'local_session' | 'remote_runtime_projection'
type MobileNodeState = 'healthy' | 'unreachable' | 'refused' | 'invalid_response'

type MobileNodeSummary = {
  nodeId: string
  state: MobileNodeState
  checkedAt: string
  answeredAt?: string | undefined
  latencyMs: number
  protocolVersion?: string | undefined
  capabilities?: {
    accept: boolean
    locate: boolean
    health: boolean
    runtimeProjection?: boolean | undefined
  }
  detail?: string | undefined
}

type MobileSessionSummary = {
  nodeId?: string | undefined
  sourceKind?: MobileSessionSourceKind | undefined
  projectionState?: 'answered' | 'unreachable' | 'refused' | 'invalid_response' | undefined
  projectionCheckedAt?: string | undefined
  projectionAnsweredAt?: string | undefined
  sessionRef: string
  displayRef: string
  title: string
  mode: MobileSessionMode
  executionMode: MobileExecutionMode
  summaryStatus: MobileSessionStatus
  /** @deprecated Use summaryStatus. Preserved for the older /mobile/sessions client. */
  status?: MobileSessionStatus | undefined
  hostSessionId: string
  generation: number
  runtimeId?: string | undefined
  activeTurnId?: string | undefined
  lastHrcSeq: number
  lastMessageSeq: number
  lastActivityAt?: string | undefined
  capabilities: {
    input: boolean
    interrupt: boolean
    launchHeadlessTurn: boolean
    history: boolean
    summary?: boolean | undefined
    semanticDm?: boolean | undefined
    timeline?: boolean | undefined
    literalInput?: boolean | undefined
    answerPrompt?: boolean | undefined
  }
  session?: {
    status: string
    generation: number
    priorHostSessionId?: string | undefined
    continuation?: HrcSessionRecord['continuation'] | undefined
    lastAppliedIntent?: HrcSessionRecord['lastAppliedIntentJson'] | undefined
    createdAt: string
    updatedAt: string
  }
  runtime?:
    | {
        status: string
        transport: string
        runtimeKind?: HrcRuntimeSnapshot['runtimeKind'] | undefined
        runtimeId: string
        launchId?: string | undefined
        activeRunId?: string | undefined
        lastActivityAt?: string | undefined
        supportsInflightInput: boolean
        adopted: boolean
        createdAt: string
        updatedAt: string
      }
    | undefined
  run?:
    | {
        status: string
        runId: string
        transport: string
        runtimeId?: string | undefined
        acceptedAt?: string | undefined
        startedAt?: string | undefined
        completedAt?: string | undefined
        errorCode?: string | undefined
        errorMessage?: string | undefined
        updatedAt: string
      }
    | undefined
  raw?:
    | {
        session: HrcSessionRecord
        runtime?: HrcRuntimeSnapshot | undefined
        run?: HrcRunRecord | undefined
      }
    | undefined
}

function thinLocalSessionForFederation(session: MobileSessionSummary): MobileSessionSummary {
  return {
    sessionRef: session.sessionRef,
    displayRef: session.displayRef,
    title: session.title,
    mode: session.mode,
    executionMode: session.executionMode,
    summaryStatus: session.summaryStatus,
    hostSessionId: session.hostSessionId,
    generation: session.generation,
    ...(session.runtimeId !== undefined ? { runtimeId: session.runtimeId } : {}),
    ...(session.activeTurnId !== undefined ? { activeTurnId: session.activeTurnId } : {}),
    lastHrcSeq: session.lastHrcSeq,
    lastMessageSeq: session.lastMessageSeq,
    ...(session.lastActivityAt !== undefined ? { lastActivityAt: session.lastActivityAt } : {}),
    capabilities: {
      input: session.capabilities.input,
      interrupt: session.capabilities.interrupt,
      launchHeadlessTurn: session.capabilities.launchHeadlessTurn,
      history: session.capabilities.history,
    },
  }
}

type MobileSessionIndex = {
  refreshedAt: string
  counts: {
    all: number
    interactive: number
    headless: number
    active: number
    stale: number
    inactive: number
    detached: number
  }
  sessions: MobileSessionSummary[]
}

type MobileSessionPageInfo = {
  nextCursor?: string | undefined
  localNodeId: string
  eventHighWater: Record<string, number>
  complete: boolean
  peerStatus: Record<string, string>
}

type MobileSessionFacets = Omit<SessionFacetsResponse, 'peerStatus'> & {
  peerStatus: Record<string, string>
}

type MobileSessionPagePayload = {
  generatedAt: string
  sessions: MobileSessionSummary[]
  recentEventsBySession: Record<string, MobileEventMessage[]>
  pageInfo: MobileSessionPageInfo
  facets: MobileSessionFacets
}

type MobileEventMessage = {
  type: 'hrc_event'
  hrcSeq: number
  streamSeq: number
  eventKind: string
  category: string
  ts: string
  payload: unknown
  scopeRef?: string | undefined
  laneRef?: string | undefined
  sessionRef?: string | undefined
  hostSessionId?: string | undefined
  generation?: number | undefined
  runtimeId?: string | undefined
  runId?: string | undefined
  launchId?: string | undefined
  replayed?: boolean | undefined
  errorCode?: string | undefined
}

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

type MobileFederationSnapshot = {
  type: 'federation_snapshot'
  generatedAt: string
  localNodeId: string
  nodes: MobileNodeSummary[]
  sessions: MobileSessionSummary[]
  detail?: string | undefined
}

function isRemoteProjectionSource(value: unknown): boolean {
  return value === 'remote_runtime_projection'
}

function remoteControlUnavailable(clientInputId?: string): Response {
  return json(
    {
      ok: false,
      ...(clientInputId !== undefined ? { clientInputId } : {}),
      code: 'remote_control_unavailable',
      message: REMOTE_CONTROL_UNAVAILABLE_MESSAGE,
    },
    422
  )
}

type MobileDmTargetsResponse = {
  targets: HrcTargetView[]
}

type MobileMessagesResponse = {
  messages: CollaborationMessage[]
}

type MobileTimelineFrame = {
  frameId: string
  frameSeq: number
  lastHrcSeq: number
  lastMessageSeq?: number | undefined
  sessionRef: string
  mode: MobileSessionMode
  frameKind:
    | 'user_prompt'
    | 'assistant_message'
    | 'tool_call'
    | 'tool_result'
    | 'tool_batch'
    | 'patch_summary'
    | 'diff_summary'
    | 'turn_status'
    | 'session_status'
    | 'input_ack'
    | 'error'
  sourceEvents: Array<{ hrcSeq: number; eventKind: string }>
  blocks: Array<{
    kind:
      | 'markdown'
      | 'mono'
      | 'tool_call'
      | 'tool_result'
      | 'command_ledger'
      | 'patch_summary'
      | 'diff_summary'
      | 'status'
      | 'raw_json'
    text?: string | undefined
    language?: string | undefined
    toolName?: string | undefined
    toolUseId?: string | undefined
    status?: string | undefined
    payload?: unknown
  }>
  actions: Array<{ actionId: string; label: string; enabled: boolean }>
  runId?: string | undefined
  turnId?: string | undefined
  ts: string
}

type MobileHistoryPage = {
  frames: MobileTimelineFrame[]
  oldestCursor: { hrcSeq: number; messageSeq: number }
  newestCursor: { hrcSeq: number; messageSeq: number }
  hasMoreBefore: boolean
  events?: MobileEventMessage[] | undefined
}

type MobileWebSocket = MobileWebSocketLike

function requireHrcClient(deps: ResolvedAcpServerDeps): AcpHrcClient {
  if (deps.hrcClient === undefined) {
    badRequest('hrcClient not configured')
  }
  return deps.hrcClient
}

function sessionRef(scopeRef: string, laneRef: string): string {
  return `${scopeRef}/lane:${laneRef}`
}

function latestRuntimeForSession(
  session: HrcSessionRecord,
  runtimes: HrcRuntimeSnapshot[]
): HrcRuntimeSnapshot | undefined {
  const matches = runtimes.filter(
    (runtime) =>
      runtime.hostSessionId === session.hostSessionId && runtime.generation === session.generation
  )
  return matches.sort((lhs, rhs) => rhs.updatedAt.localeCompare(lhs.updatedAt))[0]
}

function executionMode(
  session: HrcSessionRecord,
  runtime?: HrcRuntimeSnapshot
): MobileExecutionMode {
  const preferred = session.lastAppliedIntentJson?.execution?.preferredMode
  if (preferred === 'headless' || preferred === 'interactive' || preferred === 'nonInteractive') {
    return preferred
  }
  if (runtime?.transport === 'headless') return 'headless'
  return runtime?.supportsInflightInput === true ? 'interactive' : 'nonInteractive'
}

/**
 * `mode` is the binary the app buckets on: only an `interactive` execution mode
 * is an interactive session; `headless` and `nonInteractive` (wrkc/webhook-driven
 * workers) are both headless, and a headless transport is headless regardless.
 */
function modeForExecution(
  execution: MobileExecutionMode,
  runtime?: HrcRuntimeSnapshot
): MobileSessionMode {
  if (runtime?.transport === 'headless') return 'headless'
  return execution === 'interactive' ? 'interactive' : 'headless'
}

function mobileMode(
  execution: MobileExecutionMode,
  runtime?: HrcRuntimeSnapshot
): MobileSessionMode {
  return modeForExecution(execution, runtime)
}

const DEAD_RUNTIME_STATUSES = new Set(['dead', 'stopped', 'crashed', 'exited', 'terminated'])

function mobileStatus(status: string, runtime?: HrcRuntimeSnapshot): MobileSessionStatus {
  const normalized = status.toLowerCase()
  if (normalized.includes('stale')) return 'stale'
  if (
    normalized.includes('inactive') ||
    normalized.includes('archived') ||
    normalized.includes('closed') ||
    normalized.includes('terminated')
  ) {
    return 'inactive'
  }
  const runtimeStatus = runtime?.status.toLowerCase()
  if (runtimeStatus === 'detached') return 'detached'
  if (runtimeStatus?.includes('stale')) return 'stale'
  if (
    runtime === undefined ||
    (runtimeStatus !== undefined && DEAD_RUNTIME_STATUSES.has(runtimeStatus))
  ) {
    return 'inactive'
  }
  return 'active'
}

function titleForSession(record: HrcSessionRecord): string {
  const parts = record.scopeRef.split('/')
  return parts[parts.length - 1] || record.scopeRef
}

function projectSession(input: {
  record: HrcSessionRecord
  runtime?: HrcRuntimeSnapshot | undefined
  run?: HrcRunRecord | undefined
  lastEvent?: HrcLifecycleEvent | undefined
  raw?: boolean | undefined
  includeSessionDetails?: boolean | undefined
}): MobileSessionSummary {
  const execution = executionMode(input.record, input.runtime)
  const mode = mobileMode(execution, input.runtime)
  const status = mobileStatus(input.record.status, input.runtime)
  const runtimeActive = input.runtime?.status.toLowerCase() === 'active'
  const supportsInput = mode === 'interactive' && input.runtime?.supportsInflightInput === true
  const projectedRuntime =
    input.runtime === undefined
      ? undefined
      : {
          status: input.runtime.status,
          transport: input.runtime.transport,
          ...(input.runtime.runtimeKind !== undefined
            ? { runtimeKind: input.runtime.runtimeKind }
            : {}),
          runtimeId: input.runtime.runtimeId,
          ...(input.runtime.launchId !== undefined ? { launchId: input.runtime.launchId } : {}),
          ...(input.runtime.activeRunId !== undefined
            ? { activeRunId: input.runtime.activeRunId }
            : {}),
          ...(input.runtime.lastActivityAt !== undefined
            ? { lastActivityAt: input.runtime.lastActivityAt }
            : {}),
          supportsInflightInput: input.runtime.supportsInflightInput,
          adopted: input.runtime.adopted,
          createdAt: input.runtime.createdAt,
          updatedAt: input.runtime.updatedAt,
        }
  const projectedRun =
    input.run === undefined
      ? undefined
      : {
          status: input.run.status,
          runId: input.run.runId,
          transport: input.run.transport,
          ...(input.run.runtimeId !== undefined ? { runtimeId: input.run.runtimeId } : {}),
          ...(input.run.acceptedAt !== undefined ? { acceptedAt: input.run.acceptedAt } : {}),
          ...(input.run.startedAt !== undefined ? { startedAt: input.run.startedAt } : {}),
          ...(input.run.completedAt !== undefined ? { completedAt: input.run.completedAt } : {}),
          ...(input.run.errorCode !== undefined ? { errorCode: input.run.errorCode } : {}),
          ...(input.run.errorMessage !== undefined ? { errorMessage: input.run.errorMessage } : {}),
          updatedAt: input.run.updatedAt,
        }

  const includeSessionDetails = input.includeSessionDetails === true || input.raw === true

  return {
    sourceKind: 'local_session',
    sessionRef: sessionRef(input.record.scopeRef, input.record.laneRef),
    displayRef: sessionRef(input.record.scopeRef, input.record.laneRef),
    title: titleForSession(input.record),
    mode,
    executionMode: execution,
    summaryStatus: status,
    status,
    hostSessionId: input.record.hostSessionId,
    generation: input.record.generation,
    ...(input.runtime?.runtimeId !== undefined ? { runtimeId: input.runtime.runtimeId } : {}),
    ...(input.runtime?.activeRunId !== undefined
      ? { activeTurnId: input.runtime.activeRunId }
      : {}),
    lastHrcSeq: input.lastEvent?.hrcSeq ?? 0,
    lastMessageSeq: 0,
    lastActivityAt: input.lastEvent?.ts ?? input.runtime?.lastActivityAt ?? input.record.updatedAt,
    capabilities: {
      input: supportsInput,
      interrupt: runtimeActive || input.runtime !== undefined,
      launchHeadlessTurn: false,
      history: true,
      summary: true,
      semanticDm: true,
      timeline: true,
      literalInput: supportsInput,
      answerPrompt: true,
    },
    session: {
      status: input.record.status,
      generation: input.record.generation,
      ...(input.record.priorHostSessionId !== undefined
        ? { priorHostSessionId: input.record.priorHostSessionId }
        : {}),
      ...(includeSessionDetails && input.record.continuation !== undefined
        ? { continuation: input.record.continuation }
        : {}),
      ...(includeSessionDetails && input.record.lastAppliedIntentJson !== undefined
        ? { lastAppliedIntent: input.record.lastAppliedIntentJson }
        : {}),
      createdAt: input.record.createdAt,
      updatedAt: input.record.updatedAt,
    },
    ...(projectedRuntime !== undefined ? { runtime: projectedRuntime } : {}),
    ...(projectedRun !== undefined ? { run: projectedRun } : {}),
    ...(input.raw === true
      ? {
          raw: {
            session: input.record,
            ...(input.runtime !== undefined ? { runtime: input.runtime } : {}),
            ...(input.run !== undefined ? { run: input.run } : {}),
          },
        }
      : {}),
  }
}

function parseMobileSessionDetailsFlag(url: URL): boolean {
  return (
    parseMobileRawFlag(url) || url.searchParams.get(MOBILE_SESSION_DETAILS_QUERY_PARAM) === 'true'
  )
}

function countSessions(sessions: MobileSessionSummary[]): MobileSessionIndex['counts'] {
  return {
    all: sessions.length,
    interactive: sessions.filter((session) => session.mode === 'interactive').length,
    headless: sessions.filter((session) => session.mode === 'headless').length,
    active: sessions.filter((session) => session.summaryStatus === 'active').length,
    stale: sessions.filter((session) => session.summaryStatus === 'stale').length,
    inactive: sessions.filter((session) => session.summaryStatus === 'inactive').length,
    detached: sessions.filter((session) => session.summaryStatus === 'detached').length,
  }
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
  limit = 500
): Promise<HrcLifecycleEvent[]> {
  const events: HrcLifecycleEvent[] = []
  for await (const event of hrcClient.watch(options)) {
    events.push(event)
    if (events.length >= limit) break
  }
  return events
}

async function collectMessages(
  deps: ResolvedAcpServerDeps,
  options: {
    sessionRef?: string | undefined
    beforeMessageSeq?: number | undefined
    limit?: number | undefined
  }
): Promise<CollaborationMessage[]> {
  const limit = Math.max(options.limit ?? 80, 1)
  if (deps.collaborationLedger === undefined || options.sessionRef === undefined) return []
  const collaboration = await deps.collaborationLedger.listMessagesByMember({
    memberRef: formatScopeHandle(parseScopeRef(splitSessionRef(options.sessionRef).scopeRef)),
    presentToPrincipalRef: HUMAN_COLLABORATION_PRINCIPAL,
    ...(options.beforeMessageSeq !== undefined
      ? { beforeMessageSeq: options.beforeMessageSeq }
      : {}),
    limit,
  })
  return collaboration.messages
    .sort((lhs, rhs) => {
      const byTime = rhs.createdAt.localeCompare(lhs.createdAt)
      return byTime !== 0 ? byTime : rhs.messageSeq - lhs.messageSeq
    })
    .slice(0, limit)
}

async function waitForCollaborationPoll(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return
  await new Promise<void>((resolve) => {
    const finish = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, 1_000)
    signal.addEventListener('abort', finish, { once: true })
  })
}

async function pollCollaborationMessages(input: {
  deps: ResolvedAcpServerDeps
  selector: { roomKey: string } | { memberRef: string }
  afterMessageSeq: number
  signal: AbortSignal
  onMessage(message: CollaborationMessage): void | Promise<void>
}): Promise<void> {
  const ledger = input.deps.collaborationLedger
  if (ledger === undefined) throw new Error('collaboration ledger is not configured')
  let cursor = input.afterMessageSeq

  while (!input.signal.aborted) {
    const result =
      'roomKey' in input.selector
        ? await ledger.listMessagesByRoom({
            roomKey: input.selector.roomKey,
            presentToPrincipalRef: HUMAN_COLLABORATION_PRINCIPAL,
            limit: 200,
          })
        : await ledger.listMessagesByMember({
            memberRef: input.selector.memberRef,
            presentToPrincipalRef: HUMAN_COLLABORATION_PRINCIPAL,
            limit: 200,
          })
    const fresh = result.messages
      .filter((message) => message.messageSeq > cursor)
      .sort((lhs, rhs) => lhs.messageSeq - rhs.messageSeq)
    for (const message of fresh) {
      await input.onMessage(message)
      cursor = Math.max(cursor, message.messageSeq)
    }
    await waitForCollaborationPoll(input.signal)
  }
}

async function listMobileSessions(
  deps: ResolvedAcpServerDeps,
  url: URL
): Promise<MobileSessionIndex> {
  const hrcClient = requireHrcClient(deps)
  const scopeRef = url.searchParams.get('scopeRef') ?? undefined
  const laneRef = url.searchParams.get('laneRef') ?? undefined
  const mode = url.searchParams.get('mode')
  const status = url.searchParams.get('status')
  const query = url.searchParams.get('q')?.trim().toLowerCase()
  const raw = parseMobileRawFlag(url)
  const includeSessionDetails = parseMobileSessionDetailsFlag(url)

  const [records, runtimes, latestEvents] = await Promise.all([
    hrcClient.listSessions({
      ...(scopeRef !== undefined ? { scopeRef } : {}),
      ...(laneRef !== undefined ? { laneRef } : {}),
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
    const key = `${event.hostSessionId}:${event.generation}`
    latestEventByHostSessionGeneration.set(key, event)
  }

  let sessions = records.map((record) => {
    const generationKey = `${record.hostSessionId}:${record.generation}`
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
  return {
    refreshedAt: new Date().toISOString(),
    counts: countSessions(sessions),
    sessions,
  }
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
}): MobileSessionSummary {
  const { item } = input
  const isLocal = item.nodeId === input.localNodeId
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
    hostSessionId: item.hostSessionId,
    generation: item.generation,
    lastHrcSeq: 0,
    lastMessageSeq: 0,
    lastActivityAt: item.lastActivityAt,
    capabilities: {
      input: false,
      interrupt: false,
      launchHeadlessTurn: false,
      history: isLocal,
      summary: true,
      semanticDm: true,
      timeline: isLocal,
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

async function projectIndexedSession(input: {
  hrcClient: AcpHrcClient
  item: SessionPageItem
  localNodeId: string
  peerStatus: Record<string, SessionPeerStatus>
}): Promise<MobileSessionSummary> {
  const thin = projectThinIndexedSession(input)
  if (input.item.nodeId !== input.localNodeId) return thin

  const [sessionResult, runtimesResult] = await Promise.allSettled([
    input.hrcClient.getSession(input.item.hostSessionId),
    input.hrcClient.listRuntimes({ hostSessionId: input.item.hostSessionId, all: true, limit: 20 }),
  ])
  if (sessionResult.status !== 'fulfilled') return thin
  const record = sessionResult.value
  const runtime =
    runtimesResult.status === 'fulfilled'
      ? latestRuntimeForSession(record, runtimesResult.value)
      : undefined
  const projected = projectSession({ record, runtime })
  return {
    ...projected,
    nodeId: input.item.nodeId,
    sourceKind: 'local_session',
    mode: modeForExecution(input.item.executionMode, runtime),
    executionMode: input.item.executionMode,
    summaryStatus: input.item.effectiveStatus,
    status: input.item.effectiveStatus,
    lastActivityAt: input.item.lastActivityAt,
  }
}

async function loadMobileSessionPage(
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
    hrcClient.getSessionFacets(sessionFacetRequest(request)),
    hrcClient.getStatus({ includeSessions: false }),
  ])
  const localNodeId = status.node.nodeId
  const seen = new Set<string>()
  const items = page.items.filter((item) => {
    const key = `${item.nodeId}\u0000${item.hostSessionId}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  const sessions = await Promise.all(
    items.map((item) =>
      projectIndexedSession({ hrcClient, item, localNodeId, peerStatus: page.peerStatus })
    )
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

function projectEvent(event: HrcLifecycleEvent): MobileEventMessage {
  return {
    type: 'hrc_event',
    hrcSeq: event.hrcSeq,
    streamSeq: event.streamSeq,
    eventKind: event.eventKind,
    category: event.category,
    ts: event.ts,
    payload: event.payload,
    scopeRef: event.scopeRef,
    laneRef: event.laneRef,
    sessionRef: sessionRef(event.scopeRef, event.laneRef),
    hostSessionId: event.hostSessionId,
    generation: event.generation,
    ...(event.runtimeId !== undefined ? { runtimeId: event.runtimeId } : {}),
    ...(event.runId !== undefined ? { runId: event.runId } : {}),
    ...(event.launchId !== undefined ? { launchId: event.launchId } : {}),
    replayed: event.replayed,
    ...(event.errorCode !== undefined ? { errorCode: event.errorCode } : {}),
  }
}

function frameKind(event: HrcLifecycleEvent): MobileTimelineFrame['frameKind'] {
  if (event.errorCode !== undefined || event.category === 'inflight') return 'error'
  if (event.category === 'session') return 'session_status'
  if (event.category === 'turn' || event.category === 'runtime' || event.category === 'launch') {
    return 'turn_status'
  }
  return 'session_status'
}

function frameText(event: HrcLifecycleEvent): string {
  return `${event.eventKind} · ${event.category}`
}

function projectFrame(
  event: HrcLifecycleEvent,
  mode: MobileSessionMode = 'interactive'
): MobileTimelineFrame {
  return {
    frameId: `hrc-${event.hrcSeq}`,
    frameSeq: event.hrcSeq,
    lastHrcSeq: event.hrcSeq,
    sessionRef: sessionRef(event.scopeRef, event.laneRef),
    mode,
    frameKind: frameKind(event),
    sourceEvents: [{ hrcSeq: event.hrcSeq, eventKind: event.eventKind }],
    blocks: [
      {
        kind: 'status',
        text: frameText(event),
        status: event.eventKind,
      },
      {
        kind: 'raw_json',
        language: 'json',
        payload: event.payload,
      },
    ],
    actions: [],
    ...(event.runId !== undefined ? { runId: event.runId } : {}),
    ts: event.ts,
  }
}

type TimelineInput =
  | { kind: 'event'; event: HrcLifecycleEvent }
  | { kind: 'collaboration'; message: CollaborationMessage; sessionRef: string }

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function addressSessionRef(address: HrcMessageAddress): string | undefined {
  return address.kind === 'session' ? address.sessionRef : undefined
}

function parseMobileMessageAddress(input: unknown, field: string): HrcMessageAddress {
  if (!isRecord(input)) badRequest(`${field} must be an object`)

  const kind = input['kind']
  if (kind === 'entity') {
    const entity = input['entity']
    if (entity !== 'human' && entity !== 'system') {
      badRequest(`${field}.entity must be human or system`)
    }
    return { kind: 'entity', entity }
  }

  if (kind === 'session') {
    const sessionRefValue = input['sessionRef']
    if (typeof sessionRefValue !== 'string' || sessionRefValue.trim().length === 0) {
      badRequest(`${field}.sessionRef is required`)
    }
    return { kind: 'session', sessionRef: sessionRefValue.trim() }
  }

  badRequest(`${field}.kind must be session or entity`)
}

function readPositiveInteger(input: unknown, fallback: number, max: number): number {
  const value = typeof input === 'number' ? input : Number.parseInt(String(input ?? ''), 10)
  if (!Number.isFinite(value) || value < 1) return fallback
  return Math.min(Math.floor(value), max)
}

function readNonNegativeInteger(input: unknown): number | undefined {
  const value = typeof input === 'number' ? input : Number.parseInt(String(input ?? ''), 10)
  if (!Number.isFinite(value) || value < 0) return undefined
  return Math.floor(value)
}

function parseMobileMessageFilter(input: Record<string, unknown>): HrcMessageFilter {
  const filter: HrcMessageFilter = {}
  if (input['participant'] !== undefined) {
    filter.participant = parseMobileMessageAddress(input['participant'], 'participant')
  }
  if (input['from'] !== undefined) {
    filter.from = parseMobileMessageAddress(input['from'], 'from')
  }
  if (input['to'] !== undefined) {
    filter.to = parseMobileMessageAddress(input['to'], 'to')
  }
  if (isRecord(input['thread'])) {
    const rootMessageId = input['thread']['rootMessageId']
    if (typeof rootMessageId === 'string' && rootMessageId.trim().length > 0) {
      filter.thread = { rootMessageId: rootMessageId.trim() }
    }
  }
  if (typeof input['hostSessionId'] === 'string' && input['hostSessionId'].trim().length > 0) {
    filter.hostSessionId = input['hostSessionId'].trim()
  }
  const generation = readNonNegativeInteger(input['generation'])
  if (generation !== undefined) filter.generation = generation
  const afterSeq = readNonNegativeInteger(input['afterSeq'])
  if (afterSeq !== undefined) filter.afterSeq = afterSeq
  if (Array.isArray(input['kinds'])) {
    filter.kinds = input['kinds'].filter(
      (kind): kind is 'dm' | 'literal' | 'system' =>
        kind === 'dm' || kind === 'literal' || kind === 'system'
    )
  }
  if (Array.isArray(input['phases'])) {
    filter.phases = input['phases'].filter(
      (phase): phase is 'request' | 'response' | 'oneway' =>
        phase === 'request' || phase === 'response' || phase === 'oneway'
    )
  }
  filter.limit = readPositiveInteger(input['limit'], 50, 200)
  filter.order = input['order'] === 'asc' ? 'asc' : 'desc'

  return filter
}

function collaborationMemberRefFromMobileFilter(
  input: Record<string, unknown>
): string | undefined {
  for (const field of ['participant', 'to', 'from'] as const) {
    if (input[field] === undefined) continue
    const selected = parseMobileMessageAddress(input[field], field)
    const selectedSessionRef = addressSessionRef(selected)
    if (selectedSessionRef !== undefined) {
      return formatScopeHandle(parseScopeRef(splitSessionRef(selectedSessionRef).scopeRef))
    }
  }
  return undefined
}

function projectCollaborationMessage(
  message: CollaborationMessage,
  sessionRefValue: string,
  memberRef: string,
  mode: MobileSessionMode = 'interactive'
): MobileTimelineFrame {
  const frameKind: MobileTimelineFrame['frameKind'] =
    message.recipient?.scopeRef === memberRef || message.sender.principalRef === 'agent:lance'
      ? 'user_prompt'
      : 'assistant_message'

  return {
    frameId: `msg-${message.messageId}`,
    frameSeq: message.messageSeq,
    lastHrcSeq: 0,
    lastMessageSeq: message.messageSeq,
    sessionRef: sessionRefValue,
    mode,
    frameKind,
    sourceEvents: [],
    blocks: [
      {
        kind: 'markdown',
        text: formatCollaborationMessage(message),
        payload: {
          envelopeId: message.messageId,
          roomKey: message.roomKey,
          sender: message.sender,
          recipient: message.recipient,
          obligation: message.obligation,
          state: message.state,
        },
      },
    ],
    actions: [],
    ts: message.createdAt,
  }
}

function messageContent(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined
  const direct =
    stringField(payload, 'text') ??
    stringField(payload, 'content') ??
    stringField(payload, 'message') ??
    stringField(payload, 'prompt') ??
    stringField(payload, 'summary') ??
    stringField(payload, 'output')
  if (direct !== undefined) return direct

  const message = payload['message']
  if (isRecord(message)) {
    const content = message['content']
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      const text = content
        .map((block) => (isRecord(block) ? stringField(block, 'text') : undefined))
        .filter((part): part is string => part !== undefined)
        .join('')
      if (text.trim().length > 0) return text
    }
  }
  return undefined
}

function toolText(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined
  const input = payload['input']
  if (isRecord(input)) return JSON.stringify(input)
  const result = payload['result']
  if (isRecord(result)) {
    const content = result['content']
    if (Array.isArray(content)) {
      const text = content
        .map((block) => (isRecord(block) ? stringField(block, 'text') : undefined))
        .filter((part): part is string => part !== undefined)
        .join('')
      if (text.trim().length > 0) return text
    }
  }
  return (
    stringField(payload, 'command') ?? stringField(payload, 'cmd') ?? stringField(payload, 'output')
  )
}

function toolStatus(payload: unknown, fallback: string): string {
  if (!isRecord(payload)) return fallback
  if (typeof payload['isError'] === 'boolean')
    return payload['isError'] === true ? 'error' : 'success'
  return stringField(payload, 'status') ?? stringField(payload, 'state') ?? fallback
}

function projectPrimaryEvent(
  event: HrcLifecycleEvent,
  mode: MobileSessionMode = 'interactive'
): MobileTimelineFrame | undefined {
  if (event.errorCode !== undefined) {
    return projectFrame(event, mode)
  }

  const base = {
    frameId: `hrc-${event.hrcSeq}`,
    frameSeq: event.hrcSeq,
    lastHrcSeq: event.hrcSeq,
    sessionRef: sessionRef(event.scopeRef, event.laneRef),
    mode,
    sourceEvents: [{ hrcSeq: event.hrcSeq, eventKind: event.eventKind }],
    actions: [],
    ...(event.runId !== undefined ? { runId: event.runId } : {}),
    ts: event.ts,
  }

  switch (event.eventKind) {
    case 'turn.user_prompt': {
      const text = messageContent(event.payload)
      if (text === undefined) return undefined
      const trimmed = text.trim()
      if (
        trimmed === 'cody' ||
        trimmed.startsWith('You are Cody,') ||
        trimmed.startsWith('[DM #')
      ) {
        return undefined
      }
      return {
        ...base,
        frameKind: 'user_prompt',
        blocks: [{ kind: 'markdown', text, payload: event.payload }],
      }
    }
    case 'turn.message': {
      const text = messageContent(event.payload)
      if (text === undefined) return undefined
      return {
        ...base,
        frameKind: 'assistant_message',
        blocks: [{ kind: 'markdown', text, payload: event.payload }],
      }
    }
    case 'turn.tool_call': {
      const payload = isRecord(event.payload) ? event.payload : {}
      return {
        ...base,
        frameKind: 'tool_call',
        blocks: [
          {
            kind: 'tool_call',
            text: toolText(event.payload),
            toolName: stringField(payload, 'toolName') ?? stringField(payload, 'tool'),
            toolUseId: stringField(payload, 'toolUseId'),
            status: toolStatus(event.payload, 'running'),
            payload: event.payload,
          },
        ],
      }
    }
    case 'turn.tool_result': {
      const payload = isRecord(event.payload) ? event.payload : {}
      return {
        ...base,
        frameKind: 'tool_result',
        blocks: [
          {
            kind: 'tool_result',
            text: toolText(event.payload),
            toolName: stringField(payload, 'toolName') ?? stringField(payload, 'tool'),
            toolUseId: stringField(payload, 'toolUseId'),
            status: toolStatus(event.payload, 'success'),
            payload: event.payload,
          },
        ],
      }
    }
    case 'runtime.interrupted':
      return {
        ...base,
        frameKind: 'turn_status',
        blocks: [
          {
            kind: 'status',
            text: 'Turn interrupted',
            status: event.eventKind,
            payload: event.payload,
          },
        ],
      }
    case 'runtime.stale':
    case 'context.cleared':
      return {
        ...base,
        frameKind: 'session_status',
        blocks: [
          {
            kind: 'status',
            text: frameText(event),
            status: event.eventKind,
            payload: event.payload,
          },
        ],
      }
    case 'launch.exited': {
      const payload = isRecord(event.payload) ? event.payload : {}
      const exitCode = numberField(payload, 'exitCode')
      if (exitCode === undefined || exitCode === 0) return undefined
      return {
        ...base,
        frameKind: 'error',
        blocks: [
          {
            kind: 'status',
            text: `Launch exited with code ${exitCode}`,
            status: event.eventKind,
            payload: event.payload,
          },
        ],
      }
    }
    default:
      return undefined
  }
}

function inputTimestamp(input: TimelineInput): string {
  return input.kind === 'event' ? input.event.ts : input.message.createdAt
}

function inputSeq(input: TimelineInput): number {
  return input.kind === 'event' ? input.event.hrcSeq : input.message.messageSeq
}

function sortInputs(lhs: TimelineInput, rhs: TimelineInput): number {
  const byTime = inputTimestamp(lhs).localeCompare(inputTimestamp(rhs))
  if (byTime !== 0) return byTime
  return inputSeq(lhs) - inputSeq(rhs)
}

function resequenceFrames(frames: MobileTimelineFrame[]): MobileTimelineFrame[] {
  return frames.map((frame, index) => ({ ...frame, frameSeq: index + 1 }))
}

type ProjectedCollaborationFrame = {
  frame: MobileTimelineFrame
  message: CollaborationMessage
}

function timelineTimestampDistance(lhs: string, rhs: string): number | undefined {
  const lhsMs = Date.parse(lhs)
  const rhsMs = Date.parse(rhs)
  if (!Number.isFinite(lhsMs) || !Number.isFinite(rhsMs)) return undefined
  return Math.abs(lhsMs - rhsMs)
}

function collaborationMatchesHrcFrame(
  collaboration: ProjectedCollaborationFrame,
  hrcFrame: MobileTimelineFrame
): boolean {
  if (
    collaboration.frame.frameKind !== 'user_prompt' ||
    hrcFrame.frameKind !== 'user_prompt' ||
    collaboration.frame.sessionRef !== hrcFrame.sessionRef
  ) {
    return false
  }
  const distance = timelineTimestampDistance(collaboration.frame.ts, hrcFrame.ts)
  if (distance === undefined || distance > MOBILE_COLLABORATION_MATCH_WINDOW_MS) return false
  return hrcFrame.blocks.some(
    (block) => typeof block.text === 'string' && block.text.includes(collaboration.message.body)
  )
}

function mergeCollaborationIdentity(
  hrcFrame: MobileTimelineFrame,
  collaboration: ProjectedCollaborationFrame
): MobileTimelineFrame {
  const collaborationPayload = collaboration.frame.blocks.find(
    (block) => block.kind === 'markdown'
  )?.payload
  const collaborationMetadata = isRecord(collaborationPayload) ? collaborationPayload : {}
  const actionsById = new Map(
    [...hrcFrame.actions, ...collaboration.frame.actions].map((action) => [action.actionId, action])
  )
  return {
    ...hrcFrame,
    lastMessageSeq: Math.max(hrcFrame.lastMessageSeq ?? 0, collaboration.message.messageSeq),
    blocks: hrcFrame.blocks.map((block) => ({
      ...block,
      payload: {
        ...(isRecord(block.payload) ? block.payload : {}),
        ...collaborationMetadata,
        envelopeId: collaboration.message.messageId,
        messageSeq: collaboration.message.messageSeq,
      },
    })),
    actions: [...actionsById.values()],
  }
}

function closestCollaborationMatch(
  hrcFrame: MobileTimelineFrame,
  collaborations: readonly ProjectedCollaborationFrame[]
): ProjectedCollaborationFrame | undefined {
  return collaborations
    .filter((collaboration) => collaborationMatchesHrcFrame(collaboration, hrcFrame))
    .sort((lhs, rhs) => {
      const lhsDistance = timelineTimestampDistance(lhs.frame.ts, hrcFrame.ts) ?? Number.MAX_VALUE
      const rhsDistance = timelineTimestampDistance(rhs.frame.ts, hrcFrame.ts) ?? Number.MAX_VALUE
      return lhsDistance - rhsDistance || lhs.message.messageSeq - rhs.message.messageSeq
    })[0]
}

function dedupeCollaborationFrames(
  projected: Array<
    | { kind: 'event'; frame: MobileTimelineFrame }
    | { kind: 'collaboration'; frame: MobileTimelineFrame; message: CollaborationMessage }
  >
): MobileTimelineFrame[] {
  const collaborations = projected
    .filter(
      (
        item
      ): item is {
        kind: 'collaboration'
        frame: MobileTimelineFrame
        message: CollaborationMessage
      } => item.kind === 'collaboration' && item.frame.frameKind === 'user_prompt'
    )
    .map(({ frame, message }) => ({ frame, message }))
  const matchedMessageIds = new Set<string>()
  const mergedByFrameId = new Map<string, MobileTimelineFrame>()

  for (const item of projected) {
    if (item.kind !== 'event' || item.frame.frameKind !== 'user_prompt') continue
    const match = closestCollaborationMatch(
      item.frame,
      collaborations.filter(({ message }) => !matchedMessageIds.has(message.messageId))
    )
    if (match === undefined) continue
    matchedMessageIds.add(match.message.messageId)
    mergedByFrameId.set(item.frame.frameId, mergeCollaborationIdentity(item.frame, match))
  }

  return projected
    .filter(
      (item) => item.kind !== 'collaboration' || !matchedMessageIds.has(item.message.messageId)
    )
    .map((item) => mergedByFrameId.get(item.frame.frameId) ?? item.frame)
}

function historyPage(
  events: HrcLifecycleEvent[],
  messages: CollaborationMessage[],
  raw: boolean,
  fallbackSessionRef?: string
): MobileHistoryPage {
  const sorted = [...events].sort((lhs, rhs) => lhs.hrcSeq - rhs.hrcSeq)
  const sortedMessages = [...messages].sort((lhs, rhs) => lhs.messageSeq - rhs.messageSeq)
  const oldest = sorted[0]?.hrcSeq ?? 0
  const newest = sorted[sorted.length - 1]?.hrcSeq ?? 0
  const oldestMessage = sortedMessages[0]?.messageSeq ?? 0
  const newestMessage = sortedMessages[sortedMessages.length - 1]?.messageSeq ?? 0
  const inputs: TimelineInput[] = [
    ...sorted.map((event) => ({ kind: 'event' as const, event })),
    ...sortedMessages.map(
      (message): TimelineInput => ({
        kind: 'collaboration',
        message,
        sessionRef: fallbackSessionRef ?? 'agent:unknown/lane:main',
      })
    ),
  ].sort(sortInputs)
  const memberRef =
    fallbackSessionRef !== undefined
      ? formatScopeHandle(parseScopeRef(splitSessionRef(fallbackSessionRef).scopeRef))
      : 'unknown@unknown:primary'
  const projected = inputs
    .map((input) =>
      input.kind === 'event'
        ? {
            kind: 'event' as const,
            frame: raw ? projectFrame(input.event) : projectPrimaryEvent(input.event),
          }
        : {
            kind: 'collaboration' as const,
            frame: projectCollaborationMessage(input.message, input.sessionRef, memberRef),
            message: input.message,
          }
    )
    .filter(
      (
        item
      ): item is
        | { kind: 'event'; frame: MobileTimelineFrame }
        | { kind: 'collaboration'; frame: MobileTimelineFrame; message: CollaborationMessage } =>
        item.frame !== undefined
    )
  const frames = raw ? projected.map(({ frame }) => frame) : dedupeCollaborationFrames(projected)

  return {
    frames: resequenceFrames(frames),
    oldestCursor: { hrcSeq: oldest, messageSeq: oldestMessage },
    newestCursor: { hrcSeq: newest, messageSeq: newestMessage },
    hasMoreBefore: false,
    ...(raw ? { events: sorted.map(projectEvent) } : {}),
  }
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

function sessionGenerationKey(input: { hostSessionId: string; generation: number }): string {
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
  const key = sessionGenerationKey({
    hostSessionId: event.hostSessionId,
    generation: event.generation,
  })
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

  const sessionResult = usesPaginatedIndex
    ? await loadMobileSessionPage(deps, url, { limitParameter: 'sessionLimit' })
    : await listMobileSessions(deps, url)
  const latestEvents = usesPaginatedIndex
    ? []
    : await listCachedLatestEventBySession(hrcClient, {
        ...(scopeRef !== undefined ? { scopeRef } : {}),
        ...(laneRef !== undefined ? { laneRef } : {}),
      })
  const lastHrcSeq =
    usesPaginatedIndex && 'pageInfo' in sessionResult
      ? (sessionResult.pageInfo.eventHighWater[sessionResult.pageInfo.localNodeId] ?? 0)
      : latestHrcSeq(latestEvents)
  let lastStreamSeq = latestEvents.reduce((max, event) => Math.max(max, event.streamSeq), 0)
  const recentEventsBySession: Record<string, MobileEventMessage[]> = {}
  const sessions = sessionResult.sessions
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
        !wantedSessionKeys.has(
          sessionGenerationKey(event as { hostSessionId: string; generation: number })
        )
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
    ...(usesPaginatedIndex && 'pageInfo' in sessionResult
      ? { pageInfo: sessionResult.pageInfo, facets: sessionResult.facets }
      : {}),
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

function projectMobileNodeState(
  state: FederationPeerHealthObservation['state'] | FederationNodeRuntimeProjection['state']
): MobileNodeState {
  if (state === 'answered' || state === 'healthy') return 'healthy'
  if (state === 'invalid-response') return 'invalid_response'
  return state
}

function projectRemoteRuntime(
  runtime: HrcRuntimeSnapshot,
  node: FederationNodeRuntimeProjection
): MobileSessionSummary {
  const execution: MobileExecutionMode =
    runtime.transport === 'headless'
      ? 'headless'
      : runtime.supportsInflightInput
        ? 'interactive'
        : 'nonInteractive'
  const mode: MobileSessionMode = modeForExecution(execution, runtime)
  const status = mobileStatus(runtime.status, runtime)
  const projectionState =
    node.state === 'invalid-response' ? ('invalid_response' as const) : node.state
  return {
    nodeId: node.nodeId,
    sourceKind: 'remote_runtime_projection',
    projectionState,
    projectionCheckedAt: node.checkedAt,
    ...(node.answeredAt !== undefined ? { projectionAnsweredAt: node.answeredAt } : {}),
    sessionRef: sessionRef(runtime.scopeRef, runtime.laneRef),
    displayRef: sessionRef(runtime.scopeRef, runtime.laneRef),
    title: runtime.scopeRef.split('/').at(-1) || runtime.scopeRef,
    mode,
    executionMode: execution,
    summaryStatus: status,
    status,
    hostSessionId: runtime.hostSessionId,
    generation: runtime.generation,
    runtimeId: runtime.runtimeId,
    ...(runtime.activeRunId !== undefined ? { activeTurnId: runtime.activeRunId } : {}),
    // Remote projections never pretend that a peer-local cursor belongs to svc.
    lastHrcSeq: 0,
    lastMessageSeq: 0,
    lastActivityAt: runtime.lastActivityAt ?? runtime.updatedAt,
    capabilities: {
      input: false,
      interrupt: false,
      launchHeadlessTurn: false,
      history: false,
      summary: true,
      semanticDm: true,
      timeline: false,
      literalInput: false,
      answerPrompt: false,
    },
    session: {
      status: runtime.status,
      generation: runtime.generation,
      createdAt: runtime.createdAt,
      updatedAt: runtime.updatedAt,
    },
    runtime: {
      status: runtime.status,
      transport: runtime.transport,
      ...(runtime.runtimeKind !== undefined ? { runtimeKind: runtime.runtimeKind } : {}),
      runtimeId: runtime.runtimeId,
      ...(runtime.launchId !== undefined ? { launchId: runtime.launchId } : {}),
      ...(runtime.activeRunId !== undefined ? { activeRunId: runtime.activeRunId } : {}),
      ...(runtime.lastActivityAt !== undefined ? { lastActivityAt: runtime.lastActivityAt } : {}),
      supportsInflightInput: runtime.supportsInflightInput,
      adopted: runtime.adopted,
      createdAt: runtime.createdAt,
      updatedAt: runtime.updatedAt,
    },
  }
}

async function buildMobileFederationSnapshot(
  hrcClient: AcpHrcClient
): Promise<MobileFederationSnapshot> {
  const generatedAt = new Date().toISOString()
  if (
    hrcClient.listFederationPeerHealth === undefined ||
    hrcClient.listFederatedRuntimes === undefined
  ) {
    return {
      type: 'federation_snapshot',
      generatedAt,
      localNodeId: GATEWAY_ID,
      nodes: [],
      sessions: [],
      detail: 'Installed HRC does not expose federation projections.',
    }
  }

  const [healthResult, runtimeResult] = await Promise.allSettled([
    hrcClient.listFederationPeerHealth(),
    hrcClient.listFederatedRuntimes({}),
  ])
  const observations = healthResult.status === 'fulfilled' ? healthResult.value : []
  const report: FederationRuntimeProjectionReport | undefined =
    runtimeResult.status === 'fulfilled' ? runtimeResult.value : undefined
  const localNodeId = report?.localNodeId ?? GATEWAY_ID
  const nodes = new Map<string, MobileNodeSummary>()

  if (report !== undefined) {
    nodes.set(localNodeId, {
      nodeId: localNodeId,
      state: 'healthy',
      checkedAt: report.generatedAt,
      answeredAt: report.generatedAt,
      latencyMs: 0,
      capabilities: { accept: false, locate: true, health: true, runtimeProjection: true },
    })
    for (const node of report.nodes) {
      nodes.set(node.nodeId, {
        nodeId: node.nodeId,
        state: projectMobileNodeState(node.state),
        checkedAt: node.checkedAt,
        ...(node.answeredAt !== undefined ? { answeredAt: node.answeredAt } : {}),
        latencyMs: node.latencyMs,
        ...(node.detail !== undefined ? { detail: node.detail } : {}),
      })
    }
  }

  for (const observation of observations) {
    const existing = nodes.get(observation.nodeId)
    nodes.set(observation.nodeId, {
      nodeId: observation.nodeId,
      state: projectMobileNodeState(observation.state),
      checkedAt: observation.checkedAt,
      ...(observation.answeredAt !== undefined
        ? { answeredAt: observation.answeredAt }
        : existing?.answeredAt !== undefined
          ? { answeredAt: existing.answeredAt }
          : {}),
      latencyMs: observation.latencyMs,
      ...(observation.protocolVersion !== undefined
        ? { protocolVersion: observation.protocolVersion }
        : {}),
      ...(observation.capabilities !== undefined
        ? {
            capabilities: {
              // `accept` was retired upstream (T-07616); keep it on the iOS wire, always false.
              accept: false,
              locate: observation.capabilities.locate,
              health: observation.capabilities.health,
              ...(observation.capabilities.runtimeProjection !== undefined
                ? { runtimeProjection: observation.capabilities.runtimeProjection }
                : {}),
            },
          }
        : existing?.capabilities !== undefined
          ? { capabilities: existing.capabilities }
          : {}),
      ...(observation.detail !== undefined
        ? { detail: observation.detail }
        : existing?.detail !== undefined
          ? { detail: existing.detail }
          : {}),
    })
  }

  const details: string[] = []
  if (healthResult.status === 'rejected') {
    details.push(
      `peer health unavailable: ${healthResult.reason instanceof Error ? healthResult.reason.message : String(healthResult.reason)}`
    )
  }
  if (runtimeResult.status === 'rejected') {
    details.push(
      `runtime projection unavailable: ${runtimeResult.reason instanceof Error ? runtimeResult.reason.message : String(runtimeResult.reason)}`
    )
  }

  return {
    type: 'federation_snapshot',
    generatedAt: report?.generatedAt ?? generatedAt,
    localNodeId,
    nodes: [...nodes.values()].sort((lhs, rhs) => lhs.nodeId.localeCompare(rhs.nodeId)),
    sessions:
      report?.nodes
        .filter((node) => node.nodeId !== localNodeId)
        .flatMap((node) => node.runtimes.map((runtime) => projectRemoteRuntime(runtime, node))) ??
      [],
    ...(details.length > 0 ? { detail: details.join(' ') } : {}),
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

async function projectSessionForDashboardEvent(input: {
  hrcClient: AcpHrcClient
  event: HrcLifecycleEvent
  raw: boolean
  includeSessionDetails: boolean
}): Promise<MobileSessionSummary | undefined> {
  const records = await input.hrcClient.listSessions({
    scopeRef: input.event.scopeRef,
    laneRef: input.event.laneRef,
  })
  const record = records.find(
    (candidate) =>
      candidate.hostSessionId === input.event.hostSessionId &&
      candidate.generation === input.event.generation
  )
  if (record === undefined) return undefined

  const [runtimes, [lastEvent], run] = await Promise.all([
    input.hrcClient.listRuntimes({ hostSessionId: record.hostSessionId }),
    input.hrcClient.listLatestEventBySession({
      hostSessionId: record.hostSessionId,
      generation: record.generation,
    }),
    input.hrcClient.getLatestRunForSession({
      hostSessionId: record.hostSessionId,
      generation: record.generation,
    }),
  ])

  return projectSession({
    record,
    runtime: latestRuntimeForSession(record, runtimes),
    run: run ?? undefined,
    lastEvent: lastEvent ?? input.event,
    raw: input.raw,
    includeSessionDetails: input.includeSessionDetails,
  })
}

async function sendDashboardProjectedEvent(input: {
  ws: MobileWebSocket
  hrcClient: AcpHrcClient
  event: HrcLifecycleEvent
  raw: boolean
  includeSessionDetails: boolean
  seenHrcSeqs: Set<number>
}): Promise<void> {
  if (input.seenHrcSeqs.has(input.event.hrcSeq)) {
    console.debug(
      `mobile dashboard duplicate hrcSeq=${input.event.hrcSeq} streamSeq=${input.event.streamSeq} eventKind=${input.event.eventKind}`
    )
    return
  }
  input.seenHrcSeqs.add(input.event.hrcSeq)
  console.debug(
    `mobile dashboard event hrcSeq=${input.event.hrcSeq} streamSeq=${input.event.streamSeq} eventKind=${input.event.eventKind}`
  )
  sendMobileJsonEnvelope(input.ws, projectEvent(input.event))
  const session = await projectSessionForDashboardEvent({
    hrcClient: input.hrcClient,
    event: input.event,
    raw: input.raw,
    includeSessionDetails: input.includeSessionDetails,
  })
  if (session !== undefined) {
    sendMobileJsonEnvelope(input.ws, {
      type: 'session_updated',
      generatedAt: new Date().toISOString(),
      hrcSeq: input.event.hrcSeq,
      session,
    })
  }
}

async function openMobileDashboardWebSocket(
  ws: MobileWebSocket,
  hrcClient: AcpHrcClient,
  parsedURL: URL
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
        : await buildMobileFederationSnapshot(hrcClient)
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

  try {
    if (fromHrcSeq !== undefined && fromHrcSeq <= snapshot.cursors.lastHrcSeq) {
      for await (const event of hrcClient.watch({
        fromSeq: fromHrcSeq,
        follow: false,
        signal: abortController.signal,
      })) {
        if (abortController.signal.aborted || event.hrcSeq > snapshot.cursors.lastHrcSeq) break
        await sendDashboardProjectedEvent({
          ws,
          hrcClient,
          event,
          raw,
          includeSessionDetails,
          seenHrcSeqs,
        })
      }
    }

    for await (const event of hrcClient.watch({
      fromSeq: snapshot.cursors.nextFromHrcSeq,
      follow: true,
      signal: abortController.signal,
    })) {
      if (abortController.signal.aborted) break
      await sendDashboardProjectedEvent({
        ws,
        hrcClient,
        event,
        raw,
        includeSessionDetails,
        seenHrcSeqs,
      })
    }
  } finally {
    clearInterval(pingTimer)
  }
}

/**
 * Look up a session on the LOCAL hrc node by hostSessionId, plus its latest
 * runtime. Returns undefined when this node does not own the session — callers
 * decide whether that is a 400, a 404, or a routing signal.
 */
export async function findLocalMobileSessionByHostSessionId(
  hrcClient: AcpHrcClient,
  hostSessionId: string
): Promise<
  | {
      record: HrcSessionRecord
      runtime?: HrcRuntimeSnapshot | undefined
    }
  | undefined
> {
  // `all: true` is load-bearing (T-07575). HRC now bounds an unscoped
  // `/v1/sessions` to a recency window for display callers, and this is not a
  // display caller: it backs attach-info, timeline, input and interrupt. Without
  // it, HRCMac could not attach to or open any session older than the window —
  // a bounded view turning into a lost capability. The dashboard's own read
  // (`listMobileSessions`) deliberately stays bounded; that is the fix.
  const records = await hrcClient.listSessions({ all: true })
  const matches = records.filter((candidate) => candidate.hostSessionId === hostSessionId)
  if (matches.length === 0) {
    return undefined
  }
  // Multiple generations may exist for a hostSessionId — pick the highest.
  const record = matches.sort((lhs, rhs) => rhs.generation - lhs.generation)[0] as HrcSessionRecord
  const runtimes = await hrcClient.listRuntimes({ hostSessionId: record.hostSessionId })
  return { record, runtime: latestRuntimeForSession(record, runtimes) }
}

async function resolveMobileSessionByHostSessionId(
  hrcClient: AcpHrcClient,
  hostSessionId: string
): Promise<{
  record: HrcSessionRecord
  runtime?: HrcRuntimeSnapshot | undefined
}> {
  const resolved = await findLocalMobileSessionByHostSessionId(hrcClient, hostSessionId)
  if (resolved === undefined) {
    badRequest(`session not found: ${hostSessionId}`, { hostSessionId })
  }
  return resolved
}

export const handleMobileHealth: RouteHandler = async ({ deps }) => {
  const hrcClient = deps.hrcClient
  let hrcOk = false
  let hrcApiVersion: string | undefined = API_VERSION
  let hrcError: string | undefined

  if (hrcClient === undefined) {
    hrcError = 'hrcClient not configured'
  } else {
    try {
      const health = await hrcClient.getHealth()
      hrcOk = health.ok === true
    } catch (error) {
      hrcError = error instanceof Error ? error.message : String(error)
      hrcApiVersion = undefined
    }
  }

  const capabilities = {
    sessions: hrcClient !== undefined,
    timeline: hrcClient !== undefined,
    dashboard: hrcClient !== undefined,
    diagnostics: hrcClient !== undefined,
    input: hrcClient !== undefined,
    interrupt: hrcClient !== undefined,
    pairing: true,
    federationDashboard:
      hrcClient?.listFederationPeerHealth !== undefined &&
      hrcClient.listFederatedRuntimes !== undefined,
    nodeHealth: hrcClient?.listFederationPeerHealth !== undefined,
    remoteRuntimeProjection: hrcClient?.listFederatedRuntimes !== undefined,
    federationSummary:
      hrcClient?.listFederationPeerHealth !== undefined &&
      hrcClient.listFederatedRuntimes !== undefined,
    nodeRuntimeProjection: hrcClient?.listFederatedRuntimes !== undefined,
    semanticDm: hrcClient !== undefined,
    remoteTimeline: false,
    remoteHistory: false,
    remoteLiteralInput: false,
    remoteInterrupt: false,
  }

  return json({
    ok: hrcClient !== undefined && hrcOk,
    gatewayId: GATEWAY_ID,
    apiVersion: API_VERSION,
    hrc: {
      ok: hrcOk,
      ...(hrcApiVersion !== undefined ? { apiVersion: hrcApiVersion } : {}),
      ...(hrcError !== undefined ? { error: hrcError } : {}),
      capabilities: {
        sessions: capabilities.sessions,
        events: capabilities.timeline || capabilities.diagnostics,
        dashboard: capabilities.dashboard,
        messages: capabilities.timeline,
        literalInput: capabilities.input,
        appOwnedSessions: false,
      },
    },
    capabilities,
  })
}

export const handleMobileSessionsPage: RouteHandler = async ({ deps, url }) =>
  json(await loadMobileSessionPage(deps, url))

export const handleMobilePairing: RouteHandler = async () =>
  json({
    version: 1,
    gatewayId: GATEWAY_ID,
    displayName: 'Local ACP',
    baseURL: DEFAULT_BASE_URL,
    capabilities: {
      sessions: true,
      timeline: true,
      dashboard: true,
      diagnostics: true,
      input: true,
      interrupt: true,
    },
  })

/**
 * POST /v1/mobile/pair — the token issuance path (spec §1 pair row, §2).
 *
 * The pairing CODE is this route's credential; a bearer is never demanded here,
 * because a device that has not paired has no bearer by definition. Three cases:
 *
 *  - `{ pairingCode }` present: redeemed from ANY peer (loopback included). A
 *    valid code mints a 256-bit token, returned exactly once; only its SHA-256 is
 *    stored. Invalid/expired/replayed → the surface's one 401 shape.
 *  - no code, loopback peer: today's no-op ack, unchanged. It mints nothing.
 *  - no code, non-loopback peer: 401 once enforcement is armed. While `enforce`
 *    is false this still acks, because the dark ship is zero behavior change and
 *    the shipped iOS client pairs with no code today.
 */
export const handleMobilePair: RouteHandler = async ({ request, deps, peer }) => {
  const body = requireRecord(await parseJsonBody(request))
  const baseURL = readOptionalTrimmedStringField(body, 'baseURL') ?? DEFAULT_BASE_URL
  const pairingCode = readOptionalTrimmedStringField(body, 'pairingCode')
  const deviceName = readOptionalTrimmedStringField(body, 'deviceName')
  const store = deps.mobileAuthStore

  const ack = {
    ok: true,
    gatewayId: GATEWAY_ID,
    displayName: 'Local ACP',
    baseURL,
    pairedAt: new Date().toISOString(),
  }

  if (pairingCode !== undefined && pairingCode.length > 0) {
    const redeemed = store.redeemPairingCode(pairingCode, deviceName)
    if (redeemed === undefined) {
      return mobileUnauthorizedResponse()
    }
    return json({
      ...ack,
      pairedAt: redeemed.device.pairedAt,
      deviceId: redeemed.device.deviceId,
      // Returned once and never again: the server keeps only the hash.
      token: redeemed.token,
    })
  }

  if (store.isEnforcing() && !isLoopbackPeer(peer)) {
    return mobileUnauthorizedResponse()
  }

  return json(ack)
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

export const handleMobileMessagesWatch: RouteHandler = async () =>
  json(
    {
      ok: false,
      code: 'upgrade_required',
      message: 'Use a WebSocket upgrade for /v1/mobile/messages/watch.',
    },
    426
  )

export const handleMobileDmTargets: RouteHandler = async ({ deps, url }) => {
  const hrcClient = requireHrcClient(deps)
  const q = url.searchParams.get('q')?.trim().toLowerCase()
  const projectId = url.searchParams.get('projectId') ?? undefined
  const lane = url.searchParams.get('lane') ?? undefined
  const discover = url.searchParams.get('discover') !== 'false'
  let targets = await hrcClient.listTargets({ projectId, lane, discover })

  if (q !== undefined && q.length > 0) {
    targets = targets.filter((target) =>
      [
        target.sessionRef,
        target.scopeRef,
        target.laneRef,
        target.state,
        target.runtime?.runtimeId ?? '',
        target.runtime?.status ?? '',
        target.runtime?.transport ?? '',
      ]
        .join(' ')
        .toLowerCase()
        .includes(q)
    )
  }

  return json({ targets } satisfies MobileDmTargetsResponse)
}

export const handleMobileMessagesQuery: RouteHandler = async ({ deps, request }) => {
  const body = requireRecord(await parseJsonBody(request))
  const filter = parseMobileMessageFilter(body)
  const roomKey = stringField(body, 'roomKey')
  const memberRef = collaborationMemberRefFromMobileFilter(body)
  const beforeMessageSeq = readNonNegativeInteger(body['beforeMessageSeq'])
  const limit = filter.limit ?? 50
  const collaborationPromise =
    deps.collaborationLedger === undefined
      ? Promise.resolve({ messages: [] as CollaborationMessage[] })
      : roomKey !== undefined
        ? deps.collaborationLedger.listMessagesByRoom({
            roomKey,
            presentToPrincipalRef: HUMAN_COLLABORATION_PRINCIPAL,
            ...(beforeMessageSeq !== undefined ? { beforeMessageSeq } : {}),
            limit,
          })
        : memberRef !== undefined
          ? deps.collaborationLedger.listMessagesByMember({
              memberRef,
              presentToPrincipalRef: HUMAN_COLLABORATION_PRINCIPAL,
              ...(beforeMessageSeq !== undefined ? { beforeMessageSeq } : {}),
              limit,
            })
          : Promise.resolve({ messages: [] as CollaborationMessage[] })
  const collaboration = await collaborationPromise
  const messages = collaboration.messages
    .sort((lhs, rhs) => {
      const byTime =
        filter.order === 'asc'
          ? lhs.createdAt.localeCompare(rhs.createdAt)
          : rhs.createdAt.localeCompare(lhs.createdAt)
      return byTime !== 0
        ? byTime
        : filter.order === 'asc'
          ? lhs.messageSeq - rhs.messageSeq
          : rhs.messageSeq - lhs.messageSeq
    })
    .slice(0, limit)
  return json({ messages } satisfies MobileMessagesResponse)
}

export const handleMobileSemanticDm: RouteHandler = async ({ deps, request }) => {
  const body = requireRecord(await parseJsonBody(request))
  const text = requireTrimmedStringField(body, 'body')
  const to = parseMobileMessageAddress(body['to'], 'to')
  const replyToMessageId =
    typeof body['replyToMessageId'] === 'string' && body['replyToMessageId'].trim().length > 0
      ? body['replyToMessageId'].trim()
      : undefined
  const targetSessionRef = addressSessionRef(to)
  if (targetSessionRef === undefined) {
    badRequest('mobile human collaboration sends require to.kind=session')
  }
  const targetScopeHandle = formatScopeHandle(
    parseScopeRef(splitSessionRef(targetSessionRef).scopeRef)
  )
  const roomKey = stringField(body, 'roomKey') ?? targetScopeHandle

  if (deps.collaborationLedgerForPrincipal === undefined) {
    throw new Error('collaboration ledger is not configured')
  }
  const humanLedger = await deps.collaborationLedgerForPrincipal(HUMAN_COLLABORATION_PRINCIPAL)
  const collaboration = await humanLedger.say({
    ref: roomKey,
    to: [targetScopeHandle],
    body: text,
    ...(replyToMessageId !== undefined ? { respondTo: replyToMessageId } : {}),
    ...(stringField(body, 'idempotencyKey') !== undefined
      ? { idempotencyKey: stringField(body, 'idempotencyKey') }
      : {}),
  })

  return json({ collaboration })
}

export const handleMobileHistory: RouteHandler = async ({ deps, url }) => {
  const hrcClient = requireHrcClient(deps)
  if (isRemoteProjectionSource(url.searchParams.get('sourceKind'))) {
    return remoteControlUnavailable()
  }
  const limit = Number.parseInt(url.searchParams.get('limit') ?? '80', 10)
  const raw = url.searchParams.get('raw') === 'true'
  const parsedLimit = Number.isFinite(limit) ? limit : 80
  const beforeMessageSeq = Number.parseInt(url.searchParams.get('beforeMessageSeq') ?? '', 10)
  const sessionRefValue = url.searchParams.get('sessionRef') ?? undefined
  const [events, messages] = await Promise.all([
    collectEvents(hrcClient, parseMobileEventCursor(url), parsedLimit),
    collectMessages(deps, {
      sessionRef: sessionRefValue,
      ...(Number.isFinite(beforeMessageSeq) ? { beforeMessageSeq } : {}),
      limit: parsedLimit,
    }),
  ])
  return json(historyPage(events, messages, raw, sessionRefValue))
}

function requireHostSessionIdParam(params: Record<string, string>): string {
  const value = params['hostSessionId']
  if (typeof value !== 'string' || value.trim().length === 0) {
    badRequest('hostSessionId path segment is required')
  }
  return value
}

export const handleMobileInput: RouteHandler = async ({ deps, request, params }) => {
  const hrcClient = requireHrcClient(deps)
  const hostSessionId = requireHostSessionIdParam(params)
  const body = requireRecord(await parseJsonBody(request))
  const clientInputId = requireTrimmedStringField(body, 'clientInputId')

  if (isRemoteProjectionSource(body['sourceKind'])) {
    return remoteControlUnavailable(clientInputId)
  }
  const text = requireTrimmedStringField(body, 'text')

  try {
    const { record } = await resolveMobileSessionByHostSessionId(hrcClient, hostSessionId)
    const sessionRefValue = sessionRef(record.scopeRef, record.laneRef)
    await hrcClient.deliverLiteralBySelector({
      selector: { sessionRef: sessionRefValue },
      text,
      enter: body['enter'] !== false,
      ...(typeof body['fences'] === 'object' && body['fences'] !== null
        ? { fences: body['fences'] as never }
        : {}),
    })
    return json({ ok: true, clientInputId, acceptedAt: new Date().toISOString() })
  } catch (error) {
    return json(
      {
        ok: false,
        clientInputId,
        code: 'input_failed',
        message: error instanceof Error ? error.message : String(error),
      },
      422
    )
  }
}

export const handleMobileInterrupt: RouteHandler = async ({ deps, request, params }) => {
  const hrcClient = requireHrcClient(deps)
  const hostSessionId = requireHostSessionIdParam(params)
  const body = requireRecord(await parseJsonBody(request))
  const clientInputId = requireTrimmedStringField(body, 'clientInputId')

  if (isRemoteProjectionSource(body['sourceKind'])) {
    return remoteControlUnavailable(clientInputId)
  }

  try {
    const { runtime } = await resolveMobileSessionByHostSessionId(hrcClient, hostSessionId)
    if (runtime === undefined) {
      return json(
        { ok: false, clientInputId, code: 'not_interruptible', message: 'No runtime is attached.' },
        422
      )
    }
    await hrcClient.interrupt(runtime.runtimeId)
    return json({ ok: true, clientInputId })
  } catch (error) {
    return json(
      {
        ok: false,
        clientInputId,
        code: 'interrupt_failed',
        message: error instanceof Error ? error.message : String(error),
      },
      422
    )
  }
}

export async function openMobileWebSocket(ws: MobileWebSocket): Promise<void> {
  const { deps, url, kind, hostSessionId: pathHostSessionId, abortController } = ws.data
  const hrcClient = requireHrcClient(deps)
  const parsedURL = new URL(url)

  if (
    (kind === 'timeline' || kind === 'diagnostics') &&
    isRemoteProjectionSource(parsedURL.searchParams.get('sourceKind'))
  ) {
    sendMobileErrorEnvelope(ws, 'remote_control_unavailable', REMOTE_CONTROL_UNAVAILABLE_MESSAGE)
    ws.close(1008, 'remote control unavailable')
    return
  }

  if (kind === 'messages') {
    const filterInput = Object.fromEntries(parsedURL.searchParams.entries()) as Record<
      string,
      unknown
    >
    const afterSeq = readNonNegativeInteger(parsedURL.searchParams.get('afterSeq'))
    const roomKey = stringField(filterInput, 'roomKey')
    const memberRef = collaborationMemberRefFromMobileFilter(filterInput)
    if (roomKey === undefined && memberRef === undefined) {
      sendMobileErrorEnvelope(ws, 'invalid_filter', 'roomKey or a session participant is required')
      ws.close(1008, 'missing collaboration selector')
      return
    }
    await pollCollaborationMessages({
      deps,
      selector: roomKey !== undefined ? { roomKey } : { memberRef: memberRef as string },
      afterMessageSeq: afterSeq ?? 0,
      signal: abortController.signal,
      onMessage: (message) => {
        sendMobileJsonEnvelope(ws, { type: 'message', message })
      },
    })
    return
  }

  if (kind === 'dashboard') {
    await openMobileDashboardWebSocket(ws, hrcClient, parsedURL)
    return
  }

  if (pathHostSessionId === undefined || pathHostSessionId.length === 0) {
    sendMobileErrorEnvelope(ws, 'invalid_path', 'hostSessionId path segment is required')
    ws.close(1008, 'missing hostSessionId')
    return
  }

  let fromMessageSeq = parseMobileMessageCursor(parsedURL)
  const raw = parseMobileRawFlag(parsedURL)
  const includeSessionDetails = parseMobileSessionDetailsFlag(parsedURL)
  const cursor = parseMobileEventCursor(parsedURL)
  const options = {
    ...cursor,
    // Path-derived hostSessionId takes precedence over any query value.
    hostSessionId: pathHostSessionId,
    follow: true,
    signal: abortController.signal,
  }
  let liveFrameSeq = 1
  let sessionRefValue: string | undefined

  if (kind === 'timeline') {
    let resolved: { record: HrcSessionRecord; runtime?: HrcRuntimeSnapshot | undefined }
    try {
      resolved = await resolveMobileSessionByHostSessionId(hrcClient, pathHostSessionId)
    } catch (error) {
      sendMobileErrorEnvelope(
        ws,
        'session_not_found',
        error instanceof Error ? error.message : String(error)
      )
      ws.close(1008, 'session not found')
      return
    }
    const { record, runtime } = resolved
    sessionRefValue = sessionRef(record.scopeRef, record.laneRef)
    const [latestEvents, latestRun] = await Promise.all([
      hrcClient.listLatestEventBySession({
        hostSessionId: record.hostSessionId,
        generation: record.generation,
      }),
      hrcClient.getLatestRunForSession({
        hostSessionId: record.hostSessionId,
        generation: record.generation,
      }),
    ])
    const session = projectSession({
      record,
      runtime,
      run: latestRun ?? undefined,
      lastEvent: latestEvents[0],
      raw,
      includeSessionDetails,
    })
    const [historyEvents, historyMessages] = await Promise.all([
      collectEvents(hrcClient, { ...options, fromSeq: 1, follow: false }, 80),
      collectMessages(deps, {
        sessionRef: sessionRefValue,
        limit: 80,
      }),
    ])
    const history = historyPage(historyEvents, historyMessages, raw, sessionRefValue)
    liveFrameSeq = (history.frames.at(-1)?.frameSeq ?? 0) + 1
    // The snapshot establishes the baseline up to history.newestCursor. Advance
    // the live follow cursors to that high-water so pumpEvents/pumpMessages do
    // not re-emit already-snapshotted events/messages as fresh live frames
    // (which would append stale, out-of-order content below the snapshot).
    if (options.fromSeq === undefined || history.newestCursor.hrcSeq > options.fromSeq) {
      options.fromSeq = history.newestCursor.hrcSeq
    }
    if (history.newestCursor.messageSeq > fromMessageSeq) {
      fromMessageSeq = history.newestCursor.messageSeq
    }
    sendMobileJsonEnvelope(ws, {
      type: 'snapshot',
      session,
      snapshotHighWater: history.newestCursor,
      history,
    })
  }

  try {
    if (kind === 'diagnostics') {
      for await (const event of hrcClient.watch(options)) {
        if (abortController.signal.aborted) break
        sendMobileJsonEnvelope(ws, projectEvent(event))
      }
      return
    }

    const sendFrame = (frame: MobileTimelineFrame | undefined): void => {
      if (frame === undefined || abortController.signal.aborted) return
      sendMobileJsonEnvelope(ws, {
        type: 'frame',
        frame: { ...frame, frameSeq: liveFrameSeq++ },
      })
    }

    const memberRef =
      sessionRefValue === undefined
        ? undefined
        : formatScopeHandle(parseScopeRef(splitSessionRef(sessionRefValue).scopeRef))
    const liveMessageFloor = Number.isFinite(fromMessageSeq) ? fromMessageSeq : 0
    const handledMessageIds = new Set<string>()
    const pendingCollaborations = new Map<
      string,
      ProjectedCollaborationFrame & { timer: ReturnType<typeof setTimeout> }
    >()
    let liveMergeQueue = Promise.resolve()

    const queueLiveMerge = (operation: () => void | Promise<void>): Promise<void> => {
      const queued = liveMergeQueue.then(operation)
      liveMergeQueue = queued.catch(() => undefined)
      return queued
    }

    const clearPendingCollaboration = (messageId: string): void => {
      const pending = pendingCollaborations.get(messageId)
      if (pending !== undefined) clearTimeout(pending.timer)
      pendingCollaborations.delete(messageId)
    }

    const flushPendingCollaboration = (messageId: string): void => {
      const pending = pendingCollaborations.get(messageId)
      if (pending === undefined || handledMessageIds.has(messageId)) return
      pendingCollaborations.delete(messageId)
      handledMessageIds.add(messageId)
      sendFrame(pending.frame)
    }

    const recentLiveCollaborations = async (): Promise<ProjectedCollaborationFrame[]> => {
      if (sessionRefValue === undefined || memberRef === undefined) return []
      const messages = await collectMessages(deps, { sessionRef: sessionRefValue, limit: 80 })
      return messages
        .filter(
          (message) =>
            message.messageSeq > liveMessageFloor && !handledMessageIds.has(message.messageId)
        )
        .map((message) => ({
          message,
          frame: projectCollaborationMessage(message, sessionRefValue, memberRef),
        }))
    }

    const processLiveEvent = async (event: HrcLifecycleEvent): Promise<void> => {
      const frame = raw ? projectFrame(event) : projectPrimaryEvent(event)
      if (raw || frame?.frameKind !== 'user_prompt') {
        sendFrame(frame)
        if (raw) sendMobileJsonEnvelope(ws, projectEvent(event))
        return
      }

      await queueLiveMerge(async () => {
        const candidatesById = new Map<string, ProjectedCollaborationFrame>()
        for (const pending of pendingCollaborations.values()) {
          candidatesById.set(pending.message.messageId, pending)
        }
        for (const collaboration of await recentLiveCollaborations()) {
          candidatesById.set(collaboration.message.messageId, collaboration)
        }
        const match = closestCollaborationMatch(frame, [...candidatesById.values()])
        if (match === undefined) {
          sendFrame(frame)
          return
        }
        clearPendingCollaboration(match.message.messageId)
        handledMessageIds.add(match.message.messageId)
        sendFrame(mergeCollaborationIdentity(frame, match))
      })
    }

    const processLiveMessage = async (message: CollaborationMessage): Promise<void> => {
      if (sessionRefValue === undefined || memberRef === undefined) return
      await queueLiveMerge(() => {
        if (handledMessageIds.has(message.messageId)) return
        const frame = projectCollaborationMessage(message, sessionRefValue, memberRef)
        if (raw || frame.frameKind !== 'user_prompt') {
          handledMessageIds.add(message.messageId)
          sendFrame(frame)
          return
        }
        const timer = setTimeout(() => {
          void queueLiveMerge(() => flushPendingCollaboration(message.messageId))
        }, MOBILE_COLLABORATION_MATCH_WINDOW_MS)
        pendingCollaborations.set(message.messageId, { frame, message, timer })
      })
    }

    abortController.signal.addEventListener(
      'abort',
      () => {
        for (const pending of pendingCollaborations.values()) clearTimeout(pending.timer)
        pendingCollaborations.clear()
      },
      { once: true }
    )

    const pumpEvents = async (): Promise<void> => {
      for await (const event of hrcClient.watch(options)) {
        if (abortController.signal.aborted) break
        await processLiveEvent(event)
      }
    }

    const pumpMessages = async (): Promise<void> => {
      if (memberRef === undefined) return
      await pollCollaborationMessages({
        deps,
        selector: { memberRef },
        afterMessageSeq: Number.isFinite(fromMessageSeq) ? fromMessageSeq : 0,
        signal: abortController.signal,
        onMessage: processLiveMessage,
      })
    }

    await Promise.all([pumpEvents(), pumpMessages()])
  } catch (error) {
    if (!abortController.signal.aborted) {
      sendMobileErrorEnvelope(
        ws,
        'mobile_stream_failed',
        error instanceof Error ? error.message : String(error)
      )
    }
  }
}

export function closeMobileWebSocket(ws: MobileWebSocket): void {
  abortMobileWebSocket(ws)
}

export function handleMobileWebSocketMessage(ws: MobileWebSocket, message: string | Buffer): void {
  if (ws.data.kind !== 'dashboard') return
  const text = typeof message === 'string' ? message : message.toString('utf8')
  try {
    const parsed = JSON.parse(text) as { type?: unknown; id?: unknown }
    if (parsed.type === 'ping') {
      sendMobileJsonEnvelope(ws, {
        type: 'pong',
        ...(typeof parsed.id === 'string' ? { id: parsed.id } : {}),
        ts: new Date().toISOString(),
      })
    }
  } catch {
    if (text.trim() === 'ping') {
      sendMobileJsonEnvelope(ws, { type: 'pong', ts: new Date().toISOString() })
    }
  }
}
