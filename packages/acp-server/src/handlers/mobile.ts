import type {
  HrcLifecycleEvent,
  HrcMessageAddress,
  HrcMessageFilter,
  HrcMessageRecord,
  HrcRunRecord,
  HrcRuntimeSnapshot,
  HrcSessionRecord,
  HrcTargetView,
} from 'hrc-core'

import { badRequest, json } from '../http.js'
import {
  parseJsonBody,
  readOptionalTrimmedStringField,
  requireRecord,
  requireTrimmedStringField,
} from '../parsers/body.js'

import type { AcpHrcClient, ResolvedAcpServerDeps } from '../deps.js'
import type { RouteHandler } from '../routing/route-context.js'
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
const MAX_DASHBOARD_RECENT_EVENTS_PER_SESSION = 10
const MAX_DASHBOARD_SNAPSHOT_EVENTS = 200
const MAX_MOBILE_SESSION_RUNS = 10_000
const DEFAULT_DASHBOARD_MAX_REPLAY_EVENTS = 10_000
const DEFAULT_DASHBOARD_MAX_REPLAY_AGE_MS = 3_600_000

type MobileSessionMode = 'interactive' | 'headless'
type MobileSessionStatus = 'active' | 'stale' | 'inactive'
type MobileExecutionMode = 'interactive' | 'headless' | 'nonInteractive'

type MobileSessionSummary = {
  sessionRef: string
  displayRef: string
  title: string
  mode: MobileSessionMode
  executionMode: MobileExecutionMode
  summaryStatus: MobileSessionStatus
  /** @deprecated Use summaryStatus. Preserved for the older /mobile/sessions client. */
  status: MobileSessionStatus
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
  }
  session: {
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

type MobileSessionIndex = {
  refreshedAt: string
  counts: {
    all: number
    interactive: number
    headless: number
    active: number
    stale: number
    inactive: number
  }
  sessions: MobileSessionSummary[]
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
}

type MobileDashboardSessionsRefreshed = {
  type: 'sessions_refreshed'
  generatedAt: string
  cursors: MobileDashboardSnapshot['cursors']
  sessions: MobileSessionSummary[]
}

type MobileDmTargetsResponse = {
  targets: HrcTargetView[]
}

type MobileMessagesResponse = {
  messages: HrcMessageRecord[]
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

function mobileMode(
  execution: MobileExecutionMode,
  runtime?: HrcRuntimeSnapshot
): MobileSessionMode {
  if (execution === 'headless' || runtime?.transport === 'headless') return 'headless'
  return 'interactive'
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
  if (runtimeStatus?.includes('stale')) return 'stale'
  if (runtime === undefined || (runtimeStatus !== undefined && DEAD_RUNTIME_STATUSES.has(runtimeStatus))) {
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

  return {
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
    },
    session: {
      status: input.record.status,
      generation: input.record.generation,
      ...(input.record.priorHostSessionId !== undefined
        ? { priorHostSessionId: input.record.priorHostSessionId }
        : {}),
      ...(input.record.continuation !== undefined
        ? { continuation: input.record.continuation }
        : {}),
      ...(input.record.lastAppliedIntentJson !== undefined
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

function countSessions(sessions: MobileSessionSummary[]): MobileSessionIndex['counts'] {
  return {
    all: sessions.length,
    interactive: sessions.filter((session) => session.mode === 'interactive').length,
    headless: sessions.filter((session) => session.mode === 'headless').length,
    active: sessions.filter((session) => session.summaryStatus === 'active').length,
    stale: sessions.filter((session) => session.summaryStatus === 'stale').length,
    inactive: sessions.filter((session) => session.summaryStatus === 'inactive').length,
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
  hrcClient: AcpHrcClient,
  options: {
    sessionRef?: string | undefined
    hostSessionId?: string | undefined
    generation?: number | undefined
    beforeMessageSeq?: number | undefined
    limit?: number | undefined
  }
): Promise<HrcMessageRecord[]> {
  const response = await hrcClient.listMessages({
    ...(options.hostSessionId !== undefined ? { hostSessionId: options.hostSessionId } : {}),
    ...(options.generation !== undefined ? { generation: options.generation } : {}),
    order: 'desc',
    limit: Math.max(options.limit ?? 80, 1),
  })
  return response.messages
    .filter(
      (message) =>
        options.beforeMessageSeq === undefined || message.messageSeq < options.beforeMessageSeq
    )
    .filter(
      (message) =>
        options.sessionRef === undefined ||
        message.execution.sessionRef === undefined ||
        message.execution.sessionRef === options.sessionRef ||
        addressSessionRef(message.from) === options.sessionRef ||
        addressSessionRef(message.to) === options.sessionRef
    )
    .slice(0, options.limit ?? 80)
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

  const [records, runtimes, latestEvents] = await Promise.all([
    hrcClient.listSessions({
      ...(scopeRef !== undefined ? { scopeRef } : {}),
      ...(laneRef !== undefined ? { laneRef } : {}),
    }),
    hrcClient.listRuntimes({}),
    // Indexed SQL query returns one row per (hostSessionId, generation); does not
    // depend on a bounded recent window, so lastHrcSeq / lastActivityAt stay
    // reliable on large stores. See HrcLifecycleEventRepository.listLatestPerSession.
    hrcClient.listLatestEventBySession({
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
    })
  })

  if (mode === 'interactive' || mode === 'headless') {
    sessions = sessions.filter((session) => session.mode === mode)
  }
  if (status === 'active' || status === 'stale' || status === 'inactive') {
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
  | { kind: 'message'; message: HrcMessageRecord }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

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

const HUMAN_MESSAGE_ADDRESS: HrcMessageAddress = { kind: 'entity', entity: 'human' }

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
    filter.kinds = input['kinds'].filter((kind): kind is 'dm' | 'literal' | 'system' =>
      kind === 'dm' || kind === 'literal' || kind === 'system'
    )
  }
  if (Array.isArray(input['phases'])) {
    filter.phases = input['phases'].filter((phase): phase is 'request' | 'response' | 'oneway' =>
      phase === 'request' || phase === 'response' || phase === 'oneway'
    )
  }
  filter.limit = readPositiveInteger(input['limit'], 50, 200)
  filter.order = input['order'] === 'asc' ? 'asc' : 'desc'

  if (
    filter.participant === undefined &&
    filter.from === undefined &&
    filter.to === undefined &&
    filter.thread === undefined &&
    filter.hostSessionId === undefined
  ) {
    filter.participant = HUMAN_MESSAGE_ADDRESS
  }

  return filter
}

function sessionRefFromMessage(message: HrcMessageRecord, fallbackSessionRef?: string): string {
  return (
    message.execution.sessionRef ??
    addressSessionRef(message.from) ??
    addressSessionRef(message.to) ??
    fallbackSessionRef ??
    'unknown/lane:main'
  )
}

function messageIsFromHuman(message: HrcMessageRecord): boolean {
  return message.from.kind === 'entity' && message.from.entity === 'human'
}

function messageIsToHuman(message: HrcMessageRecord): boolean {
  return message.to.kind === 'entity' && message.to.entity === 'human'
}

function projectMessage(
  message: HrcMessageRecord,
  fallbackSessionRef?: string,
  mode: MobileSessionMode = 'interactive'
): MobileTimelineFrame | undefined {
  const frameKind: MobileTimelineFrame['frameKind'] =
    message.phase === 'response' || messageIsToHuman(message)
      ? 'assistant_message'
      : message.phase === 'request' || message.phase === 'oneway' || messageIsFromHuman(message)
        ? 'user_prompt'
        : 'session_status'

  if (frameKind === 'session_status' && message.body.trim().length === 0) return undefined

  return {
    frameId: `msg-${message.messageSeq}`,
    frameSeq: message.messageSeq,
    lastHrcSeq: 0,
    lastMessageSeq: message.messageSeq,
    sessionRef: sessionRefFromMessage(message, fallbackSessionRef),
    mode,
    frameKind,
    sourceEvents: [],
    blocks: [
      {
        kind: frameKind === 'session_status' ? 'status' : 'markdown',
        text: message.body,
        ...(frameKind === 'session_status' ? { status: message.phase } : {}),
        payload: {
          messageId: message.messageId,
          kind: message.kind,
          phase: message.phase,
          execution: message.execution,
        },
      },
    ],
    actions: [],
    ...(message.execution.runId !== undefined ? { runId: message.execution.runId } : {}),
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

function historyPage(
  events: HrcLifecycleEvent[],
  messages: HrcMessageRecord[],
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
    ...sortedMessages.map((message) => ({ kind: 'message' as const, message })),
  ].sort(sortInputs)
  const frames = inputs
    .map((input) =>
      input.kind === 'event'
        ? raw
          ? projectFrame(input.event)
          : projectPrimaryEvent(input.event)
        : projectMessage(input.message, fallbackSessionRef)
    )
    .filter((frame): frame is MobileTimelineFrame => frame !== undefined)

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

  const [index, latestEvents] = await Promise.all([
    listMobileSessions(deps, url),
    hrcClient.listLatestEventBySession({
      ...(scopeRef !== undefined ? { scopeRef } : {}),
      ...(laneRef !== undefined ? { laneRef } : {}),
    }),
  ])
  const lastHrcSeq = latestEvents.reduce((max, event) => Math.max(max, event.hrcSeq), 0)
  const lastStreamSeq = latestEvents.reduce((max, event) => Math.max(max, event.streamSeq), 0)
  const recentEventsBySession: Record<string, MobileEventMessage[]> = {}

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
    sessions: index.sessions,
    recentEventsBySession,
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
  })
}

async function sendDashboardProjectedEvent(input: {
  ws: MobileWebSocket
  hrcClient: AcpHrcClient
  event: HrcLifecycleEvent
  raw: boolean
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
  const fromHrcSeq = parseDashboardReplayCursor(parsedURL)
  const snapshot = await buildMobileDashboardSnapshot(deps, parsedURL)

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
  const sessionsRefreshed: MobileDashboardSessionsRefreshed = {
    type: 'sessions_refreshed',
    generatedAt: snapshot.generatedAt,
    cursors: snapshot.cursors,
    sessions: snapshot.sessions,
  }
  sendMobileJsonEnvelope(ws, sessionsRefreshed)

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
  }, 30_000)
  abortController.signal.addEventListener('abort', () => clearInterval(pingTimer), { once: true })

  try {
    if (fromHrcSeq !== undefined && fromHrcSeq <= snapshot.cursors.lastHrcSeq) {
      for await (const event of hrcClient.watch({
        fromSeq: fromHrcSeq,
        follow: false,
        signal: abortController.signal,
      })) {
        if (abortController.signal.aborted || event.hrcSeq > snapshot.cursors.lastHrcSeq) break
        await sendDashboardProjectedEvent({ ws, hrcClient, event, raw, seenHrcSeqs })
      }
    }

    for await (const event of hrcClient.watch({
      fromSeq: snapshot.cursors.nextFromHrcSeq,
      follow: true,
      signal: abortController.signal,
    })) {
      if (abortController.signal.aborted) break
      await sendDashboardProjectedEvent({ ws, hrcClient, event, raw, seenHrcSeqs })
    }
  } finally {
    clearInterval(pingTimer)
  }
}

async function resolveMobileSessionByHostSessionId(
  hrcClient: AcpHrcClient,
  hostSessionId: string
): Promise<{
  record: HrcSessionRecord
  runtime?: HrcRuntimeSnapshot | undefined
}> {
  const records = await hrcClient.listSessions({})
  const matches = records.filter((candidate) => candidate.hostSessionId === hostSessionId)
  if (matches.length === 0) {
    badRequest(`session not found: ${hostSessionId}`, { hostSessionId })
  }
  // Multiple generations may exist for a hostSessionId — pick the highest.
  const record = matches.sort((lhs, rhs) => rhs.generation - lhs.generation)[0] as HrcSessionRecord
  const runtimes = await hrcClient.listRuntimes({ hostSessionId: record.hostSessionId })
  return { record, runtime: latestRuntimeForSession(record, runtimes) }
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

export const handleMobilePair: RouteHandler = async ({ request }) => {
  const body = requireRecord(await parseJsonBody(request))
  const baseURL = readOptionalTrimmedStringField(body, 'baseURL') ?? DEFAULT_BASE_URL
  return json({
    ok: true,
    gatewayId: GATEWAY_ID,
    displayName: 'Local ACP',
    baseURL,
    pairedAt: new Date().toISOString(),
  })
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
  const hrcClient = requireHrcClient(deps)
  const body = requireRecord(await parseJsonBody(request))
  const response = await hrcClient.listMessages(parseMobileMessageFilter(body))
  return json({ messages: response.messages } satisfies MobileMessagesResponse)
}

export const handleMobileSemanticDm: RouteHandler = async ({ deps, request }) => {
  const hrcClient = requireHrcClient(deps)
  const body = requireRecord(await parseJsonBody(request))
  const text = requireTrimmedStringField(body, 'body')
  const to = parseMobileMessageAddress(body['to'], 'to')
  const mode = body['mode']
  const replyToMessageId =
    typeof body['replyToMessageId'] === 'string' && body['replyToMessageId'].trim().length > 0
      ? body['replyToMessageId'].trim()
      : undefined

  const response = await hrcClient.semanticDm({
    from: HUMAN_MESSAGE_ADDRESS,
    to,
    body: text,
    respondTo: HUMAN_MESSAGE_ADDRESS,
    createIfMissing: false,
    ...(mode === 'auto' || mode === 'headless' || mode === 'nonInteractive' ? { mode } : {}),
    ...(replyToMessageId !== undefined ? { replyToMessageId } : {}),
  })

  return json(response)
}

export const handleMobileHistory: RouteHandler = async ({ deps, url }) => {
  const hrcClient = requireHrcClient(deps)
  const limit = Number.parseInt(url.searchParams.get('limit') ?? '80', 10)
  const raw = url.searchParams.get('raw') === 'true'
  const parsedLimit = Number.isFinite(limit) ? limit : 80
  const generation = Number.parseInt(url.searchParams.get('generation') ?? '', 10)
  const beforeMessageSeq = Number.parseInt(url.searchParams.get('beforeMessageSeq') ?? '', 10)
  const sessionRefValue = url.searchParams.get('sessionRef') ?? undefined
  const hostSessionId = url.searchParams.get('hostSessionId') ?? undefined
  const [events, messages] = await Promise.all([
    collectEvents(hrcClient, parseMobileEventCursor(url), parsedLimit),
    collectMessages(hrcClient, {
      sessionRef: sessionRefValue,
      hostSessionId,
      ...(Number.isFinite(generation) ? { generation } : {}),
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

  if (kind === 'messages') {
    const filter = parseMobileMessageFilter(
      Object.fromEntries(parsedURL.searchParams.entries()) as Record<string, unknown>
    )
    const afterSeq = readNonNegativeInteger(parsedURL.searchParams.get('afterSeq'))
    filter.order = 'asc'
    if (afterSeq !== undefined) filter.afterSeq = afterSeq
    for await (const message of hrcClient.watchMessages({
      filter,
      follow: true,
      signal: abortController.signal,
    })) {
      if (abortController.signal.aborted) break
      sendMobileJsonEnvelope(ws, { type: 'message', message })
    }
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

  const generation = Number.parseInt(parsedURL.searchParams.get('generation') ?? '', 10)
  const fromMessageSeq = parseMobileMessageCursor(parsedURL)
  const raw = parseMobileRawFlag(parsedURL)
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
    })
    const [historyEvents, historyMessages] = await Promise.all([
      collectEvents(hrcClient, { ...options, fromSeq: 1, follow: false }, 80),
      collectMessages(hrcClient, {
        sessionRef: sessionRefValue,
        hostSessionId: pathHostSessionId,
        ...(Number.isFinite(generation) ? { generation } : {}),
        limit: 80,
      }),
    ])
    const history = historyPage(historyEvents, historyMessages, raw, sessionRefValue)
    liveFrameSeq = (history.frames.at(-1)?.frameSeq ?? 0) + 1
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

    const pumpEvents = async (): Promise<void> => {
      for await (const event of hrcClient.watch(options)) {
        if (abortController.signal.aborted) break
        sendFrame(raw ? projectFrame(event) : projectPrimaryEvent(event))
        if (raw) sendMobileJsonEnvelope(ws, projectEvent(event))
      }
    }

    const pumpMessages = async (): Promise<void> => {
      for await (const message of hrcClient.watchMessages({
        filter: {
          hostSessionId: pathHostSessionId,
          ...(Number.isFinite(generation) ? { generation } : {}),
          ...(Number.isFinite(fromMessageSeq) ? { afterSeq: fromMessageSeq } : {}),
          order: 'asc',
        },
        follow: true,
        signal: abortController.signal,
      })) {
        if (abortController.signal.aborted) break
        if (
          sessionRefValue !== undefined &&
          message.execution.sessionRef !== undefined &&
          message.execution.sessionRef !== sessionRefValue
        ) {
          continue
        }
        sendFrame(projectMessage(message, sessionRefValue))
      }
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
