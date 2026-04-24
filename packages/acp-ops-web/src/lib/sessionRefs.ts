import type { DashboardEvent, SessionTimelineRow } from 'acp-ops-projection'

export type ScopeParts = {
  agent?: string | undefined
  project?: string | undefined
  task?: string | undefined
  role?: string | undefined
  fallback?: string | undefined
}

export type SelectedRowRef = {
  hostSessionId: string
  generation: number
}

export function parseScopeRef(scopeRef: string): ScopeParts {
  const segments = scopeRef.split(':').filter(Boolean)
  const parts: ScopeParts = {}

  for (let index = 0; index < segments.length - 1; index += 2) {
    const key = segments[index]
    const value = segments[index + 1]
    if (!value) continue
    if (key === 'agent') parts.agent = value
    if (key === 'project') parts.project = value
    if (key === 'task') parts.task = value
    if (key === 'role') parts.role = value
  }

  if (!parts.agent && !parts.project && !parts.task && !parts.role) {
    parts.fallback = scopeRef
  }

  return parts
}

export function rowKey(row: SessionTimelineRow): string {
  return `${row.hostSessionId}:${row.generation}`
}

export function eventKey(event: DashboardEvent): string {
  return `${event.hostSessionId}:${event.generation}`
}

export function selectedRowRef(row: SessionTimelineRow): SelectedRowRef {
  return { hostSessionId: row.hostSessionId, generation: row.generation }
}

export function rowMatchesRef(row: SessionTimelineRow, ref?: SelectedRowRef | string): boolean {
  if (!ref) return false
  if (typeof ref === 'string') return row.rowId === ref || rowKey(row) === ref
  return row.hostSessionId === ref.hostSessionId && row.generation === ref.generation
}

export function eventMatchesRow(event: DashboardEvent, row: SessionTimelineRow): boolean {
  return eventKey(event) === rowKey(row)
}

export function sameSessionFamily(
  left: SessionTimelineRow['sessionRef'],
  right: DashboardEvent['sessionRef']
): boolean {
  return left.scopeRef === right.scopeRef && left.laneRef === right.laneRef
}

export function compactRef(value: string, maxLength = 44): string {
  if (value.length <= maxLength) return value
  return `${value.slice(0, Math.floor(maxLength * 0.58))}...${value.slice(-Math.floor(maxLength * 0.22))}`
}
