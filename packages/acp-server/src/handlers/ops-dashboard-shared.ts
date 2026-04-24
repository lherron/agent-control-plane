import {
  type DashboardEvent,
  type DashboardEventFamily,
  type HrcLifecycleEvent as ProjectionHrcLifecycleEvent,
  type SessionTimelineRow,
  buildSummary,
  deriveSessionRow,
  projectHrcToDashboardEvent,
} from 'acp-ops-projection'
import type { HrcLifecycleEvent as CoreHrcLifecycleEvent, HrcSessionRecord } from 'hrc-core'

export const DEFAULT_DASHBOARD_WINDOW_MS = 90_000
export const DEFAULT_DASHBOARD_LIMIT_SESSIONS = 50
export const DEFAULT_DASHBOARD_LIMIT_EVENTS = 5_000

type ObjectRecord = Record<string, unknown>
type ProjectionInputEvent = ProjectionHrcLifecycleEvent & {
  errorCode?: string | undefined
  transport?: string | undefined
}

export type DashboardFilters = {
  scopeRef?: string | undefined
  laneRef?: string | undefined
  projectId?: string | undefined
  hostSessionId?: string | undefined
  runtimeId?: string | undefined
  runId?: string | undefined
  family?: DashboardEventFamily | string | undefined
}

function isRecord(value: unknown): value is ObjectRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(record: ObjectRecord, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function readNumber(record: ObjectRecord, key: string): number | undefined {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function parsePositiveInteger(raw: string | null, fallback: number, min = 1): number {
  if (raw === null || raw.trim().length === 0) {
    return fallback
  }

  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < min) {
    return fallback
  }

  return parsed
}

export function parseBoolean(raw: string | null, fallback: boolean): boolean {
  if (raw === null) {
    return fallback
  }

  return raw === 'true' ? true : raw === 'false' ? false : fallback
}

export function projectCoreHrcEvent(
  raw: CoreHrcLifecycleEvent | unknown
): DashboardEvent | undefined {
  if (!isRecord(raw)) {
    return undefined
  }

  const hrcSeq = readNumber(raw, 'hrcSeq')
  const ts = readString(raw, 'ts')
  const hostSessionId = readString(raw, 'hostSessionId')
  const scopeRef = readString(raw, 'scopeRef')
  const laneRef = readString(raw, 'laneRef')
  const generation = readNumber(raw, 'generation')
  const eventKind = readString(raw, 'eventKind')

  if (
    hrcSeq === undefined ||
    ts === undefined ||
    hostSessionId === undefined ||
    scopeRef === undefined ||
    laneRef === undefined ||
    generation === undefined ||
    eventKind === undefined
  ) {
    return undefined
  }

  const event: ProjectionInputEvent = {
    hrcSeq,
    ts,
    sessionRef: { scopeRef, laneRef },
    hostSessionId,
    generation,
    eventKind,
  }

  const streamSeq = readNumber(raw, 'streamSeq')
  if (streamSeq !== undefined) event.streamSeq = streamSeq

  const runtimeId = readString(raw, 'runtimeId')
  if (runtimeId !== undefined) event.runtimeId = runtimeId

  const runId = readString(raw, 'runId')
  if (runId !== undefined) event.runId = runId

  const launchId = readString(raw, 'launchId')
  if (launchId !== undefined) event.launchId = launchId

  const category = readString(raw, 'category')
  if (category !== undefined) event.category = category

  const errorCode = readString(raw, 'errorCode')
  if (errorCode !== undefined) event.errorCode = errorCode

  const transport = readString(raw, 'transport')
  if (transport !== undefined) event.transport = transport

  if ('payload' in raw) {
    event.payload = raw['payload']
  }

  return projectHrcToDashboardEvent(event)
}

export function compareDashboardEvents(left: DashboardEvent, right: DashboardEvent): number {
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

export function scopeMatchesProject(scopeRef: string, projectId: string): boolean {
  const parts = scopeRef.split(':')
  return parts.some((part, index) => part === 'project' && parts[index + 1] === projectId)
}

export function eventMatchesFilters(event: DashboardEvent, filters: DashboardFilters): boolean {
  if (filters.scopeRef !== undefined && event.sessionRef.scopeRef !== filters.scopeRef) return false
  if (filters.laneRef !== undefined && event.sessionRef.laneRef !== filters.laneRef) return false
  if (
    filters.projectId !== undefined &&
    !scopeMatchesProject(event.sessionRef.scopeRef, filters.projectId)
  ) {
    return false
  }
  if (filters.hostSessionId !== undefined && event.hostSessionId !== filters.hostSessionId)
    return false
  if (filters.runtimeId !== undefined && event.runtimeId !== filters.runtimeId) return false
  if (filters.runId !== undefined && event.runId !== filters.runId) return false
  if (filters.family !== undefined && event.family !== filters.family) return false
  return true
}

export function rowMatchesFilters(row: SessionTimelineRow, filters: DashboardFilters): boolean {
  if (filters.scopeRef !== undefined && row.sessionRef.scopeRef !== filters.scopeRef) return false
  if (filters.laneRef !== undefined && row.sessionRef.laneRef !== filters.laneRef) return false
  if (
    filters.projectId !== undefined &&
    !scopeMatchesProject(row.sessionRef.scopeRef, filters.projectId)
  ) {
    return false
  }
  if (filters.hostSessionId !== undefined && row.hostSessionId !== filters.hostSessionId)
    return false
  if (filters.runtimeId !== undefined && row.runtime?.runtimeId !== filters.runtimeId) return false
  if (filters.runId !== undefined) {
    const rowRunId = row.runtime?.activeRunId ?? row.acp?.latestRunId
    if (rowRunId !== filters.runId) return false
  }
  return true
}

export function deriveRowsFromEvents(
  events: DashboardEvent[],
  windowMs: number
): SessionTimelineRow[] {
  const grouped = new Map<string, DashboardEvent[]>()
  for (const event of events) {
    const rowId = `${event.hostSessionId}:${event.generation}`
    const rowEvents = grouped.get(rowId) ?? []
    rowEvents.push(event)
    grouped.set(rowId, rowEvents)
  }

  return [...grouped.values()].map((rowEvents) =>
    deriveSessionRow(rowEvents.sort(compareDashboardEvents), windowMs)
  )
}

export function sessionRecordToRow(record: HrcSessionRecord): SessionTimelineRow {
  const status = record.status
  const continuity = status === 'removed' || status === 'dead' ? 'broken' : 'healthy'
  const colorRole = continuity === 'broken' ? 'warning' : 'runtime'

  return {
    rowId: `${record.hostSessionId}:${record.generation}`,
    sessionRef: {
      scopeRef: record.scopeRef,
      laneRef: record.laneRef,
    },
    hostSessionId: record.hostSessionId,
    generation: record.generation,
    runtime: {
      status,
      lastActivityAt: record.updatedAt,
    },
    visualState: {
      priority: continuity === 'broken' ? 80 : 0,
      colorRole,
      continuity,
    },
    stats: {
      eventsInWindow: 0,
      eventsPerMinute: 0,
      lastEventAt: record.updatedAt,
    },
  }
}

export function sortRows(rows: SessionTimelineRow[]): SessionTimelineRow[] {
  return [...rows].sort((left, right) => {
    if (left.visualState.priority !== right.visualState.priority) {
      return right.visualState.priority - left.visualState.priority
    }

    const leftTs = Date.parse(left.stats.lastEventAt ?? '')
    const rightTs = Date.parse(right.stats.lastEventAt ?? '')
    if (Number.isFinite(leftTs) && Number.isFinite(rightTs) && leftTs !== rightTs) {
      return rightTs - leftTs
    }

    return left.rowId.localeCompare(right.rowId)
  })
}

export function buildDashboardSummary(
  rows: SessionTimelineRow[],
  events: DashboardEvent[],
  windowMs: number
) {
  return buildSummary(rows, events, windowMs)
}
