import type { SessionDashboardSnapshot } from 'acp-ops-projection'

// Ported from acp-ops-web/src/api/snapshot.ts. The reducer store seeds itself
// from an empty snapshot before the first WS dashboard_snapshot arrives.
export function createEmptyDashboardSnapshot(
  now = new Date(0).toISOString()
): SessionDashboardSnapshot {
  return {
    serverTime: now,
    generatedAt: now,
    window: {
      fromTs: now,
      toTs: now,
      fromHrcSeq: 0,
      toHrcSeq: 0,
    },
    cursors: {
      nextFromSeq: 0,
      lastHrcSeq: 0,
      lastStreamSeq: 0,
    },
    summary: {
      counts: {
        busy: 0,
        idle: 0,
        launching: 0,
        stale: 0,
        dead: 0,
        inFlightInputs: 0,
        deliveryPending: 0,
      },
      eventRatePerMinute: 0,
      streamLagMs: 0,
      droppedEvents: 0,
      reconnectCount: 0,
    },
    sessions: [],
    events: [],
  }
}
