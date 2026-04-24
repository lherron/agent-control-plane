import { deriveSessionRow } from 'acp-ops-projection'
import type { DashboardEvent, SessionTimelineRow } from 'acp-ops-projection'

export type { DashboardEvent, SessionTimelineRow } from 'acp-ops-projection'

export type ReducerWindow = {
  fromTs: string
  toTs: string
  windowMs: number
}

export type ReducerState = {
  rows: Map<string, SessionTimelineRow>
  events: Map<string, DashboardEvent>
  lastProcessedHrcSeq: number
  droppedEvents: number
  reconnectCount: number
  window: ReducerWindow
}

export type ReducerEventFilters = {
  scopeRef?: string | undefined
  laneRef?: string | undefined
  hostSessionId?: string | undefined
  runtimeId?: string | undefined
  runId?: string | undefined
  family?: DashboardEvent['family'] | undefined
  severity?: DashboardEvent['severity'] | undefined
  fromTs?: string | undefined
  toTs?: string | undefined
}

export type ParsedNdjsonChunk = {
  events: DashboardEvent[]
  remainder: string
  droppedLines: number
}

type ObjectRecord = Record<string, unknown>

const REDACTED_VALUE = '[REDACTED]'
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

function sanitizePayloadPreview(value: unknown): { value: unknown; redacted: boolean } {
  if (Array.isArray(value)) {
    let redacted = false
    const items = value.map((item) => {
      const sanitized = sanitizePayloadPreview(item)
      redacted = redacted || sanitized.redacted
      return sanitized.value
    })
    return { value: items, redacted }
  }

  if (!isRecord(value)) {
    return { value, redacted: false }
  }

  const result: ObjectRecord = {}
  let redacted = false
  for (const [key, entry] of Object.entries(value)) {
    if (shouldRedactKey(key)) {
      result[key] = REDACTED_VALUE
      redacted = true
      continue
    }

    const sanitized = sanitizePayloadPreview(entry)
    result[key] = sanitized.value
    redacted = redacted || sanitized.redacted
  }

  return { value: result, redacted }
}

function sanitizeEvent(event: DashboardEvent): DashboardEvent {
  if (event.payloadPreview === undefined) {
    return event.redacted ? event : { ...event, redacted: true }
  }

  const sanitized = sanitizePayloadPreview(event.payloadPreview)
  return {
    ...event,
    payloadPreview: sanitized.value,
    redacted: true,
  }
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

function rowIdFor(event: DashboardEvent): string {
  return `${event.hostSessionId}:${event.generation}`
}

function eventsForRow(events: Iterable<DashboardEvent>, rowId: string): DashboardEvent[] {
  return [...events].filter((event) => rowIdFor(event) === rowId).sort(compareEvents)
}

function markSupersededRows(
  rows: Map<string, SessionTimelineRow>
): Map<string, SessionTimelineRow> {
  const maxGenerationByHost = new Map<string, number>()
  for (const row of rows.values()) {
    maxGenerationByHost.set(
      row.hostSessionId,
      Math.max(maxGenerationByHost.get(row.hostSessionId) ?? row.generation, row.generation)
    )
  }

  const nextRows = new Map(rows)
  for (const [rowId, row] of rows) {
    const maxGeneration = maxGenerationByHost.get(row.hostSessionId) ?? row.generation
    if (row.generation >= maxGeneration || row.visualState.continuity === 'blocked') {
      continue
    }

    nextRows.set(rowId, {
      ...row,
      visualState: {
        ...row.visualState,
        priority: Math.max(row.visualState.priority, 80),
        colorRole: 'warning',
        continuity: 'blocked',
      },
    })
  }

  return nextRows
}

function rebuildRows(
  events: Iterable<DashboardEvent>,
  windowMs: number
): Map<string, SessionTimelineRow> {
  const grouped = new Map<string, DashboardEvent[]>()
  for (const event of events) {
    const rowId = rowIdFor(event)
    const rowEvents = grouped.get(rowId) ?? []
    rowEvents.push(event)
    grouped.set(rowId, rowEvents)
  }

  const rows = new Map<string, SessionTimelineRow>()
  for (const [rowId, rowEvents] of grouped) {
    rows.set(rowId, deriveSessionRow(rowEvents.sort(compareEvents), windowMs))
  }

  return markSupersededRows(rows)
}

export function applyEvent(state: ReducerState, event: DashboardEvent): ReducerState {
  if (state.events.has(event.id)) {
    return state
  }

  const sanitizedEvent = sanitizeEvent(event)
  const events = new Map(state.events)
  events.set(sanitizedEvent.id, sanitizedEvent)

  const rows = new Map(state.rows)
  const rowId = rowIdFor(sanitizedEvent)
  rows.set(rowId, deriveSessionRow(eventsForRow(events.values(), rowId), state.window.windowMs))

  return {
    ...state,
    rows: markSupersededRows(rows),
    events,
    lastProcessedHrcSeq: Math.max(state.lastProcessedHrcSeq, sanitizedEvent.hrcSeq),
  }
}

export function reconnect(state: ReducerState): ReducerState {
  return {
    ...state,
    reconnectCount: state.reconnectCount + 1,
  }
}

export function setWindow(state: ReducerState, windowMs: number, nowTs: string): ReducerState {
  const toMs = Date.parse(nowTs)
  const resolvedWindowMs = Math.max(0, windowMs)
  const fromTs = Number.isFinite(toMs)
    ? new Date(toMs - resolvedWindowMs).toISOString()
    : state.window.fromTs

  return {
    ...state,
    window: {
      fromTs,
      toTs: nowTs,
      windowMs: resolvedWindowMs,
    },
    rows: rebuildRows(state.events.values(), resolvedWindowMs),
  }
}

export function compact(state: ReducerState): ReducerState {
  const fromMs = Date.parse(state.window.fromTs)
  if (!Number.isFinite(fromMs)) {
    return state
  }

  const events = new Map<string, DashboardEvent>()
  for (const [id, event] of state.events) {
    const eventMs = Date.parse(event.ts)
    if (!Number.isFinite(eventMs) || eventMs >= fromMs) {
      events.set(id, event)
    }
  }

  return {
    ...state,
    events,
    rows: rebuildRows(events.values(), state.window.windowMs),
  }
}

export function parseNdjsonChunk(buffer: string): ParsedNdjsonChunk {
  const lines = buffer.split('\n')
  const remainder = lines.pop() ?? ''
  const events: DashboardEvent[] = []
  let droppedLines = 0

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.length === 0) {
      continue
    }

    try {
      events.push(JSON.parse(trimmed) as DashboardEvent)
    } catch {
      droppedLines += 1
    }
  }

  return { events, remainder, droppedLines }
}

export function selectVisibleEvents(
  state: ReducerState,
  filters: ReducerEventFilters = {}
): DashboardEvent[] {
  return [...state.events.values()]
    .filter((event) => {
      if (filters.scopeRef !== undefined && event.sessionRef.scopeRef !== filters.scopeRef)
        return false
      if (filters.laneRef !== undefined && event.sessionRef.laneRef !== filters.laneRef)
        return false
      if (filters.hostSessionId !== undefined && event.hostSessionId !== filters.hostSessionId) {
        return false
      }
      if (filters.runtimeId !== undefined && event.runtimeId !== filters.runtimeId) return false
      if (filters.runId !== undefined && event.runId !== filters.runId) return false
      if (filters.family !== undefined && event.family !== filters.family) return false
      if (filters.severity !== undefined && event.severity !== filters.severity) return false
      if (filters.fromTs !== undefined) {
        const eventMs = Date.parse(event.ts)
        const fromMs = Date.parse(filters.fromTs)
        if (Number.isFinite(eventMs) && Number.isFinite(fromMs) && eventMs < fromMs) return false
      }
      if (filters.toTs !== undefined) {
        const eventMs = Date.parse(event.ts)
        const toMs = Date.parse(filters.toTs)
        if (Number.isFinite(eventMs) && Number.isFinite(toMs) && eventMs > toMs) return false
      }
      return true
    })
    .sort(compareEvents)
}

export function selectSortedRows(state: ReducerState): SessionTimelineRow[] {
  return [...state.rows.values()].sort((left, right) => {
    const leftTs = Date.parse(left.stats.lastEventAt ?? '')
    const rightTs = Date.parse(right.stats.lastEventAt ?? '')
    const leftValid = Number.isFinite(leftTs)
    const rightValid = Number.isFinite(rightTs)

    if (leftValid && rightValid && leftTs !== rightTs) {
      return leftTs - rightTs
    }

    if (leftValid !== rightValid) {
      return leftValid ? -1 : 1
    }

    if (left.hostSessionId !== right.hostSessionId) {
      return left.hostSessionId.localeCompare(right.hostSessionId)
    }

    return left.generation - right.generation
  })
}
