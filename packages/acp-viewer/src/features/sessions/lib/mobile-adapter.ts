import {
  type DashboardEvent,
  type HrcLifecycleEvent,
  type SessionDashboardSnapshot,
  type SessionRef,
  type SessionTimelineRow,
  buildSummary,
  deriveSessionRow,
  projectHrcToDashboardEvent,
} from 'acp-ops-projection'
import type {
  MobileDashboardSnapshotFrame,
  MobileEventMessage,
  MobileSessionSummary,
} from './mobile-frames'

// How long events live in the reducer window before compaction trims them.
// The mobile WS is a rolling live view (recentEventsBySession is bounded
// server-side); this drives client-side rate computation + retention.
export const DASHBOARD_WINDOW_MS = 10 * 60_000

function rowIdFor(event: DashboardEvent): string {
  return `${event.hostSessionId}:${event.generation}`
}

/** Split a flat "scope/lane:main" sessionRef into the projection SessionRef. */
export function parseSessionRef(ref: string): SessionRef {
  const marker = '/lane:'
  const idx = ref.indexOf(marker)
  if (idx === -1) return { scopeRef: ref, laneRef: 'main' }
  return { scopeRef: ref.slice(0, idx), laneRef: ref.slice(idx + marker.length) || 'main' }
}

type RowStatus = 'busy' | 'idle' | 'launching' | 'stale' | 'dead'

// Row sort priorities: stale/dead surface first, then busy, then everything else.
const PRIORITY_BUSY = 60
const PRIORITY_BROKEN = 80
const PRIORITY_DEFAULT = 10

/** Collapse the mobile session/runtime/run statuses into a row status the
 *  StatusStrip counts (busy/idle/launching/stale/dead). */
function deriveRowStatus(s: MobileSessionSummary): RowStatus {
  const summary = s.summaryStatus ?? s.status
  if (summary === 'stale') return 'stale'
  if (summary === 'inactive') return 'dead'
  // active session — refine by runtime/run
  if (s.activeTurnId !== undefined || s.run?.status === 'running') return 'busy'
  const rt = s.runtime?.status?.toLowerCase() ?? ''
  if (rt.includes('launch')) return 'launching'
  if (rt.includes('busy')) return 'busy'
  if (rt.includes('stale')) return 'stale'
  if (rt.includes('dead') || rt.includes('exited') || rt.includes('crashed')) return 'dead'
  return 'idle'
}

function normalizeTransport(t: string | undefined): 'tmux' | 'sdk' | undefined {
  return t === 'tmux' || t === 'sdk' ? t : undefined
}

/**
 * Map a roster MobileSessionSummary into a SessionTimelineRow so active sessions
 * render even when they have no recent events (idle-but-active). Event-derived
 * rows merge on top of these in the store (richer live data wins). Returns
 * undefined for summaries missing identity fields.
 */
export function mobileSessionToRow(s: MobileSessionSummary): SessionTimelineRow | undefined {
  if (!s.hostSessionId || !s.sessionRef) return undefined
  const status = deriveRowStatus(s)
  const continuity = status === 'stale' || status === 'dead' ? 'broken' : 'healthy'
  const priority =
    status === 'busy'
      ? PRIORITY_BUSY
      : status === 'stale' || status === 'dead'
        ? PRIORITY_BROKEN
        : PRIORITY_DEFAULT
  const transport = s.runtime ? normalizeTransport(s.runtime.transport) : undefined

  const runtime: SessionTimelineRow['runtime'] = s.runtime
    ? {
        status,
        ...(s.runtime.runtimeId !== undefined ? { runtimeId: s.runtime.runtimeId } : {}),
        ...(s.runtime.launchId !== undefined ? { launchId: s.runtime.launchId } : {}),
        ...(transport !== undefined ? { transport } : {}),
        ...(s.runtime.activeRunId !== undefined ? { activeRunId: s.runtime.activeRunId } : {}),
        ...(s.runtime.lastActivityAt !== undefined
          ? { lastActivityAt: s.runtime.lastActivityAt }
          : {}),
        ...(s.runtime.supportsInflightInput !== undefined
          ? { supportsInFlightInput: s.runtime.supportsInflightInput }
          : {}),
      }
    : { status }

  return {
    rowId: `${s.hostSessionId}:${s.generation}`,
    sessionRef: parseSessionRef(s.sessionRef),
    hostSessionId: s.hostSessionId,
    generation: s.generation,
    runtime,
    ...(s.run !== undefined ? { acp: { latestRunId: s.run.runId } } : {}),
    visualState: {
      priority,
      colorRole: status === 'stale' || status === 'dead' ? 'warning' : 'runtime',
      continuity,
    },
    stats: {
      eventsInWindow: 0,
      eventsPerMinute: 0,
      ...(s.lastActivityAt !== undefined ? { lastEventAt: s.lastActivityAt } : {}),
    },
  }
}

/**
 * Roster rows are populated only for ACTIVE sessions. Stale/inactive sessions are
 * excluded — the server reports hundreds of stale historical generations that
 * would flood the queue. A stale session that is actually emitting still appears
 * via the event-derived path (events are not roster-filtered).
 */
export function isLiveSession(s: MobileSessionSummary): boolean {
  return (s.summaryStatus ?? s.status) === 'active'
}

/** Map the roster array into rows (live sessions only). Exported for the
 *  session_updated live-upsert path in the hook. */
export function mobileRosterToRows(sessions: MobileSessionSummary[]): SessionTimelineRow[] {
  const rows: SessionTimelineRow[] = []
  for (const s of sessions) {
    if (!isLiveSession(s)) continue
    const row = mobileSessionToRow(s)
    if (row !== undefined) rows.push(row)
  }
  return rows
}

/**
 * Reshape a mobile `hrc_event` frame into the projector input and project it to
 * a DashboardEvent. Returns undefined for frames missing the identity fields the
 * projector + reducer require (scopeRef / hostSessionId).
 */
export function mobileEventToDashboardEvent(
  message: MobileEventMessage
): DashboardEvent | undefined {
  if (message.scopeRef === undefined || message.hostSessionId === undefined) {
    return undefined
  }

  const lifecycle: HrcLifecycleEvent = {
    hrcSeq: message.hrcSeq,
    streamSeq: message.streamSeq,
    ts: message.ts,
    sessionRef: {
      scopeRef: message.scopeRef,
      laneRef: message.laneRef ?? 'main',
    },
    hostSessionId: message.hostSessionId,
    generation: message.generation ?? 0,
    runtimeId: message.runtimeId,
    runId: message.runId,
    launchId: message.launchId,
    eventKind: message.eventKind,
    category: message.category,
    payload: message.payload,
  }

  const projected = projectHrcToDashboardEvent(lifecycle)
  // Synthesize a per-session-stable id (spec): hostSessionId:hrcSeq.
  return {
    ...projected,
    id: `${message.hostSessionId}:${message.hrcSeq}`,
    redacted: projected.redacted,
  }
}

/**
 * Flatten a mobile `dashboard_snapshot` frame into a SessionDashboardSnapshot the
 * reducer store can load. Events are derived from recentEventsBySession; rows are
 * left to the reducer (sessions:[]), but a summary is derived up front so the
 * StatusStrip has correct counts on first paint.
 */
export function mobileSnapshotToDashboardSnapshot(
  frame: MobileDashboardSnapshotFrame
): SessionDashboardSnapshot {
  const events: DashboardEvent[] = []
  for (const bucket of Object.values(frame.recentEventsBySession)) {
    for (const message of bucket) {
      const event = mobileEventToDashboardEvent(message)
      if (event !== undefined) events.push(event)
    }
  }
  events.sort((a, b) => a.hrcSeq - b.hrcSeq)

  // Roster rows for every live session (incl. active-but-idle ones with no
  // recent events). The store merges event-derived rows on top of these.
  const rosterRows = mobileRosterToRows(frame.sessions)

  // Fall back to event-derived rows for summary counts when the roster is empty
  // (e.g. test frames); the reducer re-derives its own rows on load regardless.
  const grouped = new Map<string, DashboardEvent[]>()
  for (const event of events) {
    const rowId = rowIdFor(event)
    const list = grouped.get(rowId) ?? []
    list.push(event)
    grouped.set(rowId, list)
  }
  const eventRows: SessionTimelineRow[] = []
  for (const list of grouped.values()) {
    eventRows.push(deriveSessionRow(list, DASHBOARD_WINDOW_MS))
  }
  const summaryRows = rosterRows.length > 0 ? rosterRows : eventRows

  const toTs = frame.generatedAt
  const toMs = Date.parse(toTs)
  const fromTs = Number.isFinite(toMs) ? new Date(toMs - DASHBOARD_WINDOW_MS).toISOString() : toTs

  return {
    serverTime: frame.generatedAt,
    generatedAt: frame.generatedAt,
    window: {
      fromTs,
      toTs,
      fromHrcSeq: Math.max(0, frame.cursors.lastHrcSeq - events.length),
      toHrcSeq: frame.cursors.lastHrcSeq,
    },
    cursors: {
      nextFromSeq: frame.cursors.nextFromHrcSeq,
      lastHrcSeq: frame.cursors.lastHrcSeq,
      lastStreamSeq: frame.cursors.lastStreamSeq,
    },
    summary: buildSummary(summaryRows, events, DASHBOARD_WINDOW_MS),
    sessions: rosterRows,
    events,
  }
}
