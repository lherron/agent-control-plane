import type {
  DashboardEvent,
  DashboardEventFamily,
  DashboardEventSeverity,
  SessionRef,
  SessionTimelineRow,
  StreamConnectionState,
} from '@/features/sessions/types'

export const EVENT_FAMILIES: DashboardEventFamily[] = [
  'runtime',
  'agent_message',
  'tool',
  'input',
  'delivery',
  'handoff',
  'surface',
  'context',
  'warning',
]

export const FAMILY_ACCENT: Record<DashboardEventFamily, string> = {
  runtime: 'bg-cyan-300',
  agent_message: 'bg-ink-link',
  tool: 'bg-accent',
  input: 'bg-violet-300',
  delivery: 'bg-success',
  handoff: 'bg-pink-400',
  surface: 'bg-slate-300',
  context: 'bg-orange-300',
  warning: 'bg-destructive',
}

export const FAMILY_TEXT: Record<DashboardEventFamily, string> = {
  runtime: 'text-cyan-200',
  agent_message: 'text-ink-link',
  tool: 'text-accent-warm',
  input: 'text-violet-200',
  delivery: 'text-success',
  handoff: 'text-pink-300',
  surface: 'text-slate-300',
  context: 'text-orange-300',
  warning: 'text-destructive',
}

export const FAMILY_BORDER: Record<DashboardEventFamily, string> = {
  runtime: 'border-cyan-300/35',
  agent_message: 'border-ink-link/35',
  tool: 'border-accent/45',
  input: 'border-violet-300/35',
  delivery: 'border-success/40',
  handoff: 'border-pink-400/35',
  surface: 'border-slate-300/30',
  context: 'border-orange-300/35',
  warning: 'border-destructive/45',
}

export function severityTone(severity: DashboardEventSeverity): string {
  if (severity === 'error') return 'text-destructive'
  if (severity === 'warning') return 'text-warn'
  if (severity === 'success') return 'text-success'
  return 'text-muted'
}

export function connectionTone(state: StreamConnectionState): string {
  if (state === 'connected') return 'bg-success text-background'
  if (state === 'paused') return 'bg-warn text-background'
  if (state === 'reconnecting' || state === 'replaying') return 'bg-accent text-background'
  if (state === 'degraded') return 'bg-destructive text-foreground'
  return 'bg-secondary text-muted border border-border'
}

export type ScopeParts = {
  agentId?: string | undefined
  projectId?: string | undefined
  taskId?: string | undefined
  role?: string | undefined
  fallback?: string | undefined
}

export function parseScopeRef(scopeRef: string): ScopeParts {
  const segments = scopeRef.split(':').filter(Boolean)
  const parts: ScopeParts = {}

  for (let index = 0; index < segments.length - 1; index += 2) {
    const key = segments[index]
    const value = segments[index + 1]
    if (!value) continue
    if (key === 'agent') parts.agentId = value
    if (key === 'project') parts.projectId = value
    if (key === 'task') parts.taskId = value
    if (key === 'role') parts.role = value
  }

  if (!parts.agentId && !parts.projectId && !parts.taskId && !parts.role) {
    parts.fallback = scopeRef
  }

  return parts
}

export function agentIdFromSessionRef(ref: SessionRef): string | undefined {
  return parseScopeRef(ref.scopeRef).agentId
}

export function rowSelected(row: SessionTimelineRow, selectedRowId: string | undefined): boolean {
  return (
    row.rowId === selectedRowId ||
    `${row.hostSessionId}:${row.generation}` === selectedRowId ||
    `${row.sessionRef.scopeRef}:${row.sessionRef.laneRef}` === selectedRowId
  )
}

export function compactRef(value: string, maxLength = 44): string {
  if (value.length <= maxLength) return value
  const head = Math.floor(maxLength * 0.58)
  const tail = Math.floor(maxLength * 0.22)
  return `${value.slice(0, head)}...${value.slice(-tail)}`
}

export function clockLabel(ts?: string): string {
  if (!ts) return '--:--:--'
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) return '--:--:--'
  return date.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

export function durationLabel(ts?: string): string {
  if (!ts) return '00:00:00'
  const delta = Math.max(0, Date.now() - Date.parse(ts))
  const totalSeconds = Math.floor(delta / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

export function payloadPreview(event: DashboardEvent, maxLength = 180): string {
  if (event.shortDetail) return event.shortDetail
  const value = event.payloadPreview
  if (value === undefined) return event.label
  const rendered = typeof value === 'string' ? value : JSON.stringify(value)
  if (!rendered) return event.label
  return rendered.length <= maxLength ? rendered : `${rendered.slice(0, maxLength - 1)}...`
}
