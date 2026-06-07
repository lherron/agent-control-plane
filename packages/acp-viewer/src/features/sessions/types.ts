// Shared contract for the live sessions feature (hrc dashboard over the mobile WS).
// Re-exports the browser-safe projection contracts and the connection-state union
// so UI and data layers depend on one stable seam.

export type {
  DashboardEvent,
  DashboardEventFamily,
  DashboardEventSeverity,
  SessionDashboardSnapshot,
  SessionDashboardSummary,
  SessionRef,
  SessionTimelineRow,
} from 'acp-ops-projection'

// Connection lifecycle for the dashboard socket. Mirrors the legacy ops-web
// StreamConnectionState union so the reducer store ports verbatim.
export type StreamConnectionState =
  | 'connected'
  | 'reconnecting'
  | 'replaying'
  | 'paused'
  | 'degraded'
  | 'disconnected'

export type FamilyFilter = import('acp-ops-projection').DashboardEventFamily | 'all'
