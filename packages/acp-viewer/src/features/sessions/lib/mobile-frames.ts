// Wire types for the /v1/mobile/dashboard WebSocket frames.
// Mirrors the server shapes in packages/acp-server/src/handlers/mobile.ts
// (MobileEventMessage / MobileDashboardSnapshot / …). Kept local because the
// server does not export them.

export type MobileEventMessage = {
  type: 'hrc_event'
  hrcSeq: number
  streamSeq: number
  eventKind: string
  category: string
  ts: string
  payload: unknown
  scopeRef?: string | undefined
  laneRef?: string | undefined
  sessionRef?: string | undefined
  hostSessionId?: string | undefined
  generation?: number | undefined
  runtimeId?: string | undefined
  runId?: string | undefined
  launchId?: string | undefined
  replayed?: boolean | undefined
  errorCode?: string | undefined
}

export type MobileDashboardCursors = {
  lastHrcSeq: number
  lastStreamSeq: number
  nextFromHrcSeq: number
}

export type MobileSessionSummary = {
  // Opaque for MVP — the dashboard derives rows from the event stream, not these.
  scopeRef?: string | undefined
  hostSessionId?: string | undefined
  [key: string]: unknown
}

export type MobileDashboardSnapshotFrame = {
  type: 'dashboard_snapshot'
  generatedAt: string
  cursors: MobileDashboardCursors
  sessions: MobileSessionSummary[]
  recentEventsBySession: Record<string, MobileEventMessage[]>
}

export type MobileSessionsRefreshedFrame = {
  type: 'sessions_refreshed'
  generatedAt: string
  cursors: MobileDashboardCursors
  sessions: MobileSessionSummary[]
}

export type MobileSessionUpdatedFrame = {
  type: 'session_updated'
  session: MobileSessionSummary
}

export type MobilePingFrame = {
  type: 'ping'
  ts?: string | undefined
}

export type MobileErrorFrame = {
  type: 'error'
  code: string
  message?: string | undefined
}

export type MobileFrame =
  | MobileEventMessage
  | MobileDashboardSnapshotFrame
  | MobileSessionsRefreshedFrame
  | MobileSessionUpdatedFrame
  | MobilePingFrame
  | MobileErrorFrame
