export type DashboardEventFamily =
  | 'runtime'
  | 'agent_message'
  | 'tool'
  | 'input'
  | 'delivery'
  | 'handoff'
  | 'surface'
  | 'context'
  | 'warning'

export type DashboardEventSeverity = 'info' | 'success' | 'warning' | 'error'

export type SessionRef = {
  scopeRef: string
  laneRef: string
}

export type DashboardEvent = {
  id: string
  hrcSeq: number
  streamSeq?: number | undefined
  ts: string
  sessionRef: SessionRef
  hostSessionId: string
  generation: number
  runtimeId?: string | undefined
  runId?: string | undefined
  launchId?: string | undefined
  eventKind: string
  category?: string | undefined
  family: DashboardEventFamily
  severity: DashboardEventSeverity
  label: string
  shortDetail?: string | undefined
  payloadPreview?: unknown
  redacted: boolean
}

export type SessionTimelineRow = {
  rowId: string
  sessionRef: SessionRef
  hostSessionId: string
  generation: number
  runtime?:
    | {
        runtimeId?: string | undefined
        launchId?: string | undefined
        transport?: 'tmux' | 'sdk' | undefined
        harness?: string | undefined
        provider?: string | undefined
        status?: 'launching' | 'idle' | 'busy' | 'stale' | 'dead' | string | undefined
        supportsInFlightInput?: boolean | undefined
        activeRunId?: string | undefined
        lastActivityAt?: string | undefined
      }
    | undefined
  acp?:
    | {
        latestRunId?: string | undefined
        inputAttemptId?: string | undefined
        taskId?: string | undefined
        workflowPreset?: string | undefined
        deliveryPending?: boolean | undefined
      }
    | undefined
  visualState: {
    priority: number
    colorRole: 'runtime' | 'message' | 'tool' | 'input' | 'delivery' | 'warning'
    continuity: 'healthy' | 'blocked' | 'broken' | 'unknown'
  }
  stats: {
    eventsInWindow: number
    eventsPerMinute: number
    lastEventAt?: string | undefined
  }
}

export type SessionDashboardSummary = {
  counts: {
    busy: number
    idle: number
    launching: number
    stale: number
    dead: number
    inFlightInputs: number
    deliveryPending: number
  }
  eventRatePerMinute: number
  streamLagMs?: number | undefined
  droppedEvents?: number | undefined
  reconnectCount?: number | undefined
}

export type SessionDashboardSnapshot = {
  serverTime: string
  generatedAt: string
  window: {
    fromTs: string
    toTs: string
    fromHrcSeq?: number | undefined
    toHrcSeq?: number | undefined
  }
  cursors: {
    nextFromSeq: number
    lastHrcSeq?: number | undefined
    lastStreamSeq?: number | undefined
  }
  summary: SessionDashboardSummary
  sessions: SessionTimelineRow[]
  events: DashboardEvent[]
}

export type RedactionOptions = {
  payloadPreviewTextLimit?: number | undefined
  payloadPreviewObjectDepth?: number | undefined
  payloadPreviewArrayLimit?: number | undefined
  rawPayloadDebug?: boolean | undefined
}

export const defaultRedactionOptions = {
  payloadPreviewTextLimit: 240,
  payloadPreviewObjectDepth: 3,
  payloadPreviewArrayLimit: 20,
  rawPayloadDebug: false,
} as const satisfies Required<RedactionOptions>

export type HrcLifecycleEvent = {
  hrcSeq: number
  streamSeq?: number | undefined
  ts: string
  sessionRef: SessionRef
  hostSessionId: string
  generation: number
  runtimeId?: string | undefined
  runId?: string | undefined
  launchId?: string | undefined
  eventKind: string
  category?: string | undefined
  payload?: unknown
}

type ObjectRecord = Record<string, unknown>
type ResolvedRedactionOptions = {
  payloadPreviewTextLimit: number
  payloadPreviewObjectDepth: number
  payloadPreviewArrayLimit: number
  rawPayloadDebug: boolean
}

const REDACTED_VALUE = '[REDACTED]'
const MAX_DEPTH_VALUE = '[MaxDepth]'
const BINARY_VALUE = '[Binary]'
const CIRCULAR_VALUE = '[Circular]'

const CREDENTIAL_KEY_PARTS = [
  'token',
  'secret',
  'password',
  'cookie',
  'bearer',
  'apikey',
  'accesskey',
  'refreshtoken',
] as const

const RAW_PROVIDER_KEYS = new Set([
  'providerpayload',
  'rawproviderpayload',
  'rawpayload',
  'rawresponse',
  'rawproviderresponse',
])

function isRecord(value: unknown): value is ObjectRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function shouldRedactKey(key: string): boolean {
  const normalized = normalizedKey(key)
  return (
    CREDENTIAL_KEY_PARTS.some((part) => normalized.includes(part)) ||
    RAW_PROVIDER_KEYS.has(normalized)
  )
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function payloadRecord(event: HrcLifecycleEvent): ObjectRecord | undefined {
  return isRecord(event.payload) ? event.payload : undefined
}

function payloadType(event: HrcLifecycleEvent): string | undefined {
  return readString(payloadRecord(event)?.['type'])
}

function payloadErrorCode(event: HrcLifecycleEvent): string | undefined {
  return readString(payloadRecord(event)?.['errorCode'])
}

function topLevelString(event: HrcLifecycleEvent, key: string): string | undefined {
  return readString((event as unknown as ObjectRecord)[key])
}

function eventErrorCode(event: HrcLifecycleEvent): string | undefined {
  return topLevelString(event, 'errorCode') ?? payloadErrorCode(event)
}

function eventKindIncludes(event: HrcLifecycleEvent, fragment: string): boolean {
  return event.eventKind.toLowerCase().includes(fragment)
}

function isRejectionKind(event: HrcLifecycleEvent): boolean {
  const kind = event.eventKind.toLowerCase()
  return kind.includes('reject') || kind.includes('rejected') || kind.includes('denied')
}

function deriveFamily(event: HrcLifecycleEvent): DashboardEventFamily {
  const type = payloadType(event)

  if (type === 'message_start' || type === 'message_update' || type === 'message_end') {
    return 'agent_message'
  }

  if (
    type === 'tool_execution_start' ||
    type === 'tool_execution_update' ||
    type === 'tool_execution_end'
  ) {
    return 'tool'
  }

  if (type?.startsWith('user_input_')) {
    return 'input'
  }

  if (eventErrorCode(event) !== undefined || isRejectionKind(event)) {
    return 'warning'
  }

  if (event.category === 'runtime' || event.category === 'launch') {
    return 'runtime'
  }

  if (event.eventKind === 'turn.accepted') {
    return 'runtime'
  }

  if (event.eventKind.startsWith('inflight.')) {
    return 'input'
  }

  if (eventKindIncludes(event, 'delivery')) {
    return 'delivery'
  }

  if (eventKindIncludes(event, 'handoff') || eventKindIncludes(event, 'wake')) {
    return 'handoff'
  }

  if (event.category === 'surface') {
    return 'surface'
  }

  if (event.category === 'context') {
    return 'context'
  }

  return 'runtime'
}

function deriveSeverity(event: HrcLifecycleEvent): DashboardEventSeverity {
  if (eventErrorCode(event) !== undefined || eventKindIncludes(event, 'error')) {
    return 'error'
  }

  if (eventKindIncludes(event, 'warning') || isRejectionKind(event)) {
    return 'warning'
  }

  const kind = event.eventKind.toLowerCase()
  const type = payloadType(event)
  if (
    kind.endsWith('.end') ||
    kind.endsWith('.completed') ||
    kind.endsWith('.succeeded') ||
    type === 'message_end' ||
    type === 'tool_execution_end'
  ) {
    return 'success'
  }

  return 'info'
}

function eventLabel(event: HrcLifecycleEvent): string {
  return payloadType(event) ?? event.eventKind
}

function eventShortDetail(event: HrcLifecycleEvent): string | undefined {
  return eventErrorCode(event) ?? payloadType(event) ?? event.category
}

function redactionOptions(opts: RedactionOptions): ResolvedRedactionOptions {
  return {
    payloadPreviewTextLimit:
      opts.payloadPreviewTextLimit ?? defaultRedactionOptions.payloadPreviewTextLimit,
    payloadPreviewObjectDepth:
      opts.payloadPreviewObjectDepth ?? defaultRedactionOptions.payloadPreviewObjectDepth,
    payloadPreviewArrayLimit:
      opts.payloadPreviewArrayLimit ?? defaultRedactionOptions.payloadPreviewArrayLimit,
    rawPayloadDebug:
      opts.rawPayloadDebug === true || process.env['ACP_DASHBOARD_RAW_PAYLOAD'] === '1',
  }
}

function isBinaryLike(value: unknown): boolean {
  return (
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value) ||
    (typeof Blob !== 'undefined' && value instanceof Blob)
  )
}

function redactValue(
  value: unknown,
  opts: ResolvedRedactionOptions,
  depth: number,
  seen: WeakSet<object>
): { value: unknown; redacted: boolean } {
  if (typeof value === 'string') {
    const limit = Math.max(0, opts.payloadPreviewTextLimit)
    if (value.length > limit) {
      return { value: `${value.slice(0, limit)}...`, redacted: true }
    }

    return { value, redacted: false }
  }

  if (value === null || typeof value !== 'object') {
    return { value, redacted: false }
  }

  if (isBinaryLike(value)) {
    return { value: BINARY_VALUE, redacted: true }
  }

  if (seen.has(value)) {
    return { value: CIRCULAR_VALUE, redacted: true }
  }

  const maxDepth = Math.max(0, opts.payloadPreviewObjectDepth)
  if (depth >= maxDepth) {
    return { value: MAX_DEPTH_VALUE, redacted: true }
  }

  seen.add(value)

  if (Array.isArray(value)) {
    const limit = Math.max(0, opts.payloadPreviewArrayLimit)
    let redacted = value.length > limit
    const preview = value.slice(0, limit).map((item) => {
      const next = redactValue(item, opts, depth + 1, seen)
      redacted = redacted || next.redacted
      return next.value
    })
    seen.delete(value)
    return { value: preview, redacted }
  }

  const preview: ObjectRecord = {}
  let redacted = false

  for (const [key, entryValue] of Object.entries(value)) {
    if (shouldRedactKey(key)) {
      preview[key] = REDACTED_VALUE
      redacted = true
      continue
    }

    const next = redactValue(entryValue, opts, depth + 1, seen)
    preview[key] = next.value
    redacted = redacted || next.redacted
  }

  seen.delete(value)
  return { value: preview, redacted }
}

function compareEvents(left: DashboardEvent, right: DashboardEvent): number {
  const leftTs = Date.parse(left.ts)
  const rightTs = Date.parse(right.ts)
  const leftValid = Number.isFinite(leftTs)
  const rightValid = Number.isFinite(rightTs)

  if (leftValid && rightValid && leftTs !== rightTs) {
    return leftTs - rightTs
  }

  if (leftValid !== rightValid) {
    return leftValid ? -1 : 1
  }

  return left.hrcSeq - right.hrcSeq
}

function eventPayload(event: DashboardEvent): ObjectRecord | undefined {
  return isRecord(event.payloadPreview) ? event.payloadPreview : undefined
}

function eventString(event: DashboardEvent, key: string): string | undefined {
  return readString(eventPayload(event)?.[key])
}

function eventBoolean(event: DashboardEvent, key: string): boolean | undefined {
  return readBoolean(eventPayload(event)?.[key])
}

function latestString(events: DashboardEvent[], key: string): string | undefined {
  let latest: string | undefined
  for (const event of events) {
    latest = eventString(event, key) ?? latest
  }
  return latest
}

function latestBoolean(events: DashboardEvent[], key: string): boolean | undefined {
  let latest: boolean | undefined
  for (const event of events) {
    latest = eventBoolean(event, key) ?? latest
  }
  return latest
}

function deriveRuntimeStatus(events: DashboardEvent[]): string | undefined {
  let status: string | undefined

  for (const event of events) {
    status = eventString(event, 'status') ?? status
    const kind = event.eventKind.toLowerCase()
    const type = eventString(event, 'type')

    if (kind.includes('dead') || kind.includes('terminated') || kind.includes('exit')) {
      status = 'dead'
    } else if (kind.includes('stale')) {
      status = 'stale'
    } else if (kind.includes('launch')) {
      status = 'launching'
    } else if (
      kind === 'turn.accepted' ||
      kind.includes('busy') ||
      type === 'message_start' ||
      type === 'tool_execution_start'
    ) {
      status = 'busy'
    } else if (kind.includes('idle') || type === 'message_end' || type === 'tool_execution_end') {
      status = 'idle'
    }
  }

  return status
}

function isInputPending(events: DashboardEvent[]): boolean {
  for (const event of events) {
    if (event.family !== 'input') {
      continue
    }

    const kind = event.eventKind.toLowerCase()
    const type = eventString(event, 'type')?.toLowerCase()
    if (
      kind.includes('accepted') ||
      kind.includes('queued') ||
      type?.includes('received') ||
      type?.includes('queued')
    ) {
      return true
    }
  }

  return false
}

function isDeliveryPending(events: DashboardEvent[]): boolean {
  for (const event of events) {
    if (event.family !== 'delivery') {
      continue
    }

    const status = eventString(event, 'status')?.toLowerCase()
    const kind = event.eventKind.toLowerCase()
    if (status === 'pending' || status === 'queued' || kind.includes('pending')) {
      return true
    }
  }

  return false
}

function colorRoleFor(
  events: DashboardEvent[],
  status?: string
): SessionTimelineRow['visualState']['colorRole'] {
  if (events.some((event) => event.family === 'warning' || event.severity === 'error')) {
    return 'warning'
  }

  const latest = events.at(-1)
  if (latest === undefined) {
    return 'runtime'
  }

  if (latest.family === 'agent_message') {
    return 'message'
  }

  if (
    latest.family === 'runtime' ||
    latest.family === 'tool' ||
    latest.family === 'input' ||
    latest.family === 'delivery'
  ) {
    return latest.family
  }

  return status === 'dead' || status === 'stale' ? 'warning' : 'runtime'
}

function continuityFor(
  events: DashboardEvent[],
  status?: string
): SessionTimelineRow['visualState']['continuity'] {
  if (status === 'dead') {
    return 'broken'
  }

  if (
    status === 'stale' ||
    events.some(
      (event) =>
        event.family === 'warning' || event.severity === 'warning' || event.severity === 'error'
    )
  ) {
    return 'blocked'
  }

  if (status !== undefined) {
    return 'healthy'
  }

  return 'unknown'
}

function priorityFor(
  status: string | undefined,
  inputPending: boolean,
  deliveryPending: boolean,
  continuity: SessionTimelineRow['visualState']['continuity']
): number {
  if (inputPending && status === 'busy') {
    return 90
  }

  if (
    continuity === 'blocked' ||
    continuity === 'broken' ||
    status === 'stale' ||
    status === 'dead'
  ) {
    return 80
  }

  if (status === 'launching') {
    return 70
  }

  if (status === 'busy') {
    return 60
  }

  if (deliveryPending) {
    return 50
  }

  if (status === 'idle') {
    return 10
  }

  return 0
}

function eventsInWindow(events: DashboardEvent[], windowMs: number): DashboardEvent[] {
  if (events.length === 0) {
    return []
  }

  const latestTs = Math.max(
    ...events.map((event) => Date.parse(event.ts)).filter((timestamp) => Number.isFinite(timestamp))
  )

  if (!Number.isFinite(latestTs)) {
    return events
  }

  const fromTs = latestTs - Math.max(0, windowMs)
  return events.filter((event) => {
    const timestamp = Date.parse(event.ts)
    return !Number.isFinite(timestamp) || timestamp >= fromTs
  })
}

function eventRate(events: DashboardEvent[], windowMs: number): number {
  if (windowMs <= 0) {
    return 0
  }

  return events.length / (windowMs / 60_000)
}

export function projectHrcToDashboardEvent(
  event: HrcLifecycleEvent,
  opts: RedactionOptions = {}
): DashboardEvent {
  const preview = redactPayload(event.payload, opts)
  const projected: DashboardEvent = {
    id: `hrc:${event.hrcSeq}`,
    hrcSeq: event.hrcSeq,
    ts: event.ts,
    sessionRef: event.sessionRef,
    hostSessionId: event.hostSessionId,
    generation: event.generation,
    eventKind: event.eventKind,
    family: deriveFamily(event),
    severity: deriveSeverity(event),
    label: eventLabel(event),
    redacted: preview.redacted,
  }

  if (event.streamSeq !== undefined) projected.streamSeq = event.streamSeq
  if (event.runtimeId !== undefined) projected.runtimeId = event.runtimeId
  if (event.runId !== undefined) projected.runId = event.runId
  if (event.launchId !== undefined) projected.launchId = event.launchId
  if (event.category !== undefined) projected.category = event.category
  if (event.payload !== undefined) projected.payloadPreview = preview.payloadPreview

  const shortDetail = eventShortDetail(event)
  if (shortDetail !== undefined) projected.shortDetail = shortDetail

  return projected
}

export function deriveSessionRow(events: DashboardEvent[], windowMs: number): SessionTimelineRow {
  if (events.length === 0) {
    throw new Error('deriveSessionRow requires at least one event')
  }

  const orderedEvents = [...events].sort(compareEvents)
  const latest = orderedEvents[orderedEvents.length - 1]
  if (latest === undefined) {
    throw new Error('deriveSessionRow requires at least one event')
  }
  const status = deriveRuntimeStatus(orderedEvents)
  const inputPending = isInputPending(orderedEvents)
  const deliveryPending =
    latestBoolean(orderedEvents, 'deliveryPending') ?? isDeliveryPending(orderedEvents)
  const continuity = continuityFor(orderedEvents, status)
  const windowEvents = eventsInWindow(orderedEvents, windowMs)

  const runtime: NonNullable<SessionTimelineRow['runtime']> = {}
  const runtimeId = latestString(orderedEvents, 'runtimeId') ?? latest.runtimeId
  const launchId = latestString(orderedEvents, 'launchId') ?? latest.launchId
  const transport = latestString(orderedEvents, 'transport')
  const harness = latestString(orderedEvents, 'harness')
  const provider = latestString(orderedEvents, 'provider')
  const activeRunId = latestString(orderedEvents, 'activeRunId') ?? latest.runId
  const supportsInFlightInput = latestBoolean(orderedEvents, 'supportsInFlightInput')
  const lastActivityAt = latestString(orderedEvents, 'lastActivityAt') ?? latest.ts

  if (runtimeId !== undefined) runtime.runtimeId = runtimeId
  if (launchId !== undefined) runtime.launchId = launchId
  if (transport === 'tmux' || transport === 'sdk') runtime.transport = transport
  if (harness !== undefined) runtime.harness = harness
  if (provider !== undefined) runtime.provider = provider
  if (status !== undefined) runtime.status = status
  if (supportsInFlightInput !== undefined) runtime.supportsInFlightInput = supportsInFlightInput
  if (activeRunId !== undefined) runtime.activeRunId = activeRunId
  if (lastActivityAt !== undefined) runtime.lastActivityAt = lastActivityAt

  const acp: NonNullable<SessionTimelineRow['acp']> = {}
  const latestRunId = latestString(orderedEvents, 'latestRunId') ?? latest.runId
  const inputAttemptId = latestString(orderedEvents, 'inputAttemptId')
  const taskId = latestString(orderedEvents, 'taskId')
  const workflowPreset = latestString(orderedEvents, 'workflowPreset')

  if (latestRunId !== undefined) acp.latestRunId = latestRunId
  if (inputAttemptId !== undefined) acp.inputAttemptId = inputAttemptId
  if (taskId !== undefined) acp.taskId = taskId
  if (workflowPreset !== undefined) acp.workflowPreset = workflowPreset
  if (deliveryPending !== undefined) acp.deliveryPending = deliveryPending

  const row: SessionTimelineRow = {
    rowId: `${latest.hostSessionId}:${latest.generation}`,
    sessionRef: latest.sessionRef,
    hostSessionId: latest.hostSessionId,
    generation: latest.generation,
    visualState: {
      priority: priorityFor(
        status,
        inputPending || inputAttemptId !== undefined,
        deliveryPending === true,
        continuity
      ),
      colorRole: colorRoleFor(orderedEvents, status),
      continuity,
    },
    stats: {
      eventsInWindow: windowEvents.length,
      eventsPerMinute: eventRate(windowEvents, windowMs),
      lastEventAt: latest.ts,
    },
  }

  if (Object.keys(runtime).length > 0) row.runtime = runtime
  if (Object.keys(acp).length > 0) row.acp = acp

  return row
}

export function redactPayload(
  payload: unknown,
  opts: RedactionOptions = {}
): {
  payloadPreview: unknown
  redacted: boolean
} {
  const resolvedOptions = redactionOptions(opts)
  if (resolvedOptions.rawPayloadDebug) {
    return { payloadPreview: payload, redacted: false }
  }

  const preview = redactValue(payload, resolvedOptions, 0, new WeakSet<object>())
  return { payloadPreview: preview.value, redacted: preview.redacted }
}

export function buildSummary(
  rows: SessionTimelineRow[],
  events: DashboardEvent[],
  windowMs: number
): SessionDashboardSummary {
  const windowEvents = eventsInWindow(events, windowMs)
  const summary: SessionDashboardSummary = {
    counts: {
      busy: 0,
      idle: 0,
      launching: 0,
      stale: 0,
      dead: 0,
      inFlightInputs: 0,
      deliveryPending: 0,
    },
    eventRatePerMinute: eventRate(windowEvents, windowMs),
  }

  for (const row of rows) {
    const status = row.runtime?.status
    if (status === 'busy') summary.counts.busy += 1
    if (status === 'idle') summary.counts.idle += 1
    if (status === 'launching') summary.counts.launching += 1
    if (status === 'stale') summary.counts.stale += 1
    if (status === 'dead') summary.counts.dead += 1
    if (row.acp?.inputAttemptId !== undefined) summary.counts.inFlightInputs += 1
    if (row.acp?.deliveryPending === true) summary.counts.deliveryPending += 1
  }

  return summary
}
