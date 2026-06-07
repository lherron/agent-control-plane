import {
  type DashboardEvent,
  type HrcLifecycleEvent,
  type SessionDashboardSnapshot,
  type SessionTimelineRow,
  buildSummary,
  deriveSessionRow,
  projectHrcToDashboardEvent,
} from 'acp-ops-projection'
import type { MobileDashboardSnapshotFrame, MobileEventMessage } from './mobile-frames'

// How long events live in the reducer window before compaction trims them.
// The mobile WS is a rolling live view (recentEventsBySession is bounded
// server-side); this drives client-side rate computation + retention.
export const DASHBOARD_WINDOW_MS = 10 * 60_000

function rowIdFor(event: DashboardEvent): string {
  return `${event.hostSessionId}:${event.generation}`
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
  return { ...projected, id: `${message.hostSessionId}:${message.hrcSeq}`, redacted: projected.redacted }
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

  // Derive rows from the flattened events purely to compute correct initial
  // counts; the reducer re-derives its own rows when the snapshot loads.
  const grouped = new Map<string, DashboardEvent[]>()
  for (const event of events) {
    const rowId = rowIdFor(event)
    const list = grouped.get(rowId) ?? []
    list.push(event)
    grouped.set(rowId, list)
  }
  const rows: SessionTimelineRow[] = []
  for (const list of grouped.values()) {
    rows.push(deriveSessionRow(list, DASHBOARD_WINDOW_MS))
  }

  const toTs = frame.generatedAt
  const toMs = Date.parse(toTs)
  const fromTs = Number.isFinite(toMs)
    ? new Date(toMs - DASHBOARD_WINDOW_MS).toISOString()
    : toTs

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
    summary: buildSummary(rows, events, DASHBOARD_WINDOW_MS),
    sessions: [],
    events,
  }
}
