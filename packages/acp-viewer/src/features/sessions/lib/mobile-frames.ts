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

export type MobileSessionStatus = 'active' | 'stale' | 'inactive'

export type MobileSessionSummary = {
  sessionRef: string
  displayRef?: string | undefined
  title?: string | undefined
  mode?: string | undefined
  summaryStatus: MobileSessionStatus
  /** @deprecated mirror of summaryStatus from older clients */
  status?: MobileSessionStatus | undefined
  hostSessionId: string
  generation: number
  runtimeId?: string | undefined
  activeTurnId?: string | undefined
  lastHrcSeq?: number | undefined
  lastActivityAt?: string | undefined
  runtime?:
    | {
        status: string
        transport?: string | undefined
        runtimeId?: string | undefined
        launchId?: string | undefined
        activeRunId?: string | undefined
        lastActivityAt?: string | undefined
        supportsInflightInput?: boolean | undefined
      }
    | undefined
  run?:
    | {
        status: string
        runId: string
      }
    | undefined
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
