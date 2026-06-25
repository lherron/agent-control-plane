import { REDACTED_VALUE, deriveSessionRow, isRecord, shouldRedactKey } from 'acp-ops-projection'
import type { DashboardEvent, ObjectRecord, SessionTimelineRow } from 'acp-ops-projection'

export type { DashboardEvent, SessionTimelineRow } from 'acp-ops-projection'

type ReducerWindow = {
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

type ReducerEventFilters = {
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

const SUPERSEDED_PRIORITY_FLOOR = 80
const SUPERSEDED_COLOR_ROLE = 'warning'
const SUPERSEDED_CONTINUITY = 'blocked'

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

function compareByTimestamp(leftTs: number, rightTs: number, tieBreak: () => number): number {
  const leftValid = Number.isFinite(leftTs)
  const rightValid = Number.isFinite(rightTs)

  if (leftValid && rightValid && leftTs !== rightTs) {
    return leftTs - rightTs
  }

  if (leftValid !== rightValid) {
    return leftValid ? -1 : 1
  }

  return tieBreak()
}

function compareEvents(left: DashboardEvent, right: DashboardEvent): number {
  return compareByTimestamp(
    Date.parse(left.ts),
    Date.parse(right.ts),
    () => left.hrcSeq - right.hrcSeq
  )
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
    if (row.generation >= maxGeneration || row.visualState.continuity === SUPERSEDED_CONTINUITY) {
      continue
    }

    nextRows.set(rowId, {
      ...row,
      visualState: {
        ...row.visualState,
        priority: Math.max(row.visualState.priority, SUPERSEDED_PRIORITY_FLOOR),
        colorRole: SUPERSEDED_COLOR_ROLE,
        continuity: SUPERSEDED_CONTINUITY,
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

function withinTimeBound(eventTs: string, bound: string, direction: 'from' | 'to'): boolean {
  const eventMs = Date.parse(eventTs)
  const boundMs = Date.parse(bound)
  if (!Number.isFinite(eventMs) || !Number.isFinite(boundMs)) {
    return true
  }
  return direction === 'from' ? eventMs >= boundMs : eventMs <= boundMs
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
      if (filters.fromTs !== undefined && !withinTimeBound(event.ts, filters.fromTs, 'from'))
        return false
      if (filters.toTs !== undefined && !withinTimeBound(event.ts, filters.toTs, 'to')) return false
      return true
    })
    .sort(compareEvents)
}

export function selectSortedRows(state: ReducerState): SessionTimelineRow[] {
  return [...state.rows.values()].sort((left, right) =>
    compareByTimestamp(
      Date.parse(left.stats.lastEventAt ?? ''),
      Date.parse(right.stats.lastEventAt ?? ''),
      () => {
        if (left.hostSessionId !== right.hostSessionId) {
          return left.hostSessionId.localeCompare(right.hostSessionId)
        }
        return left.generation - right.generation
      }
    )
  )
}
