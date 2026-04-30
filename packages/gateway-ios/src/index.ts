/**
 * gateway-ios public API surface.
 *
 * Re-exports the module lifecycle, config, contracts, and internal types
 * that downstream consumers (acp-cli, tests) need.
 */

// Module lifecycle
export { createGatewayIosModule } from './module.js'
export type { GatewayIosModule, GatewayIosModuleOptions } from './module.js'

// Config
export { resolveConfig, DEFAULT_HOST, DEFAULT_PORT, DEFAULT_GATEWAY_ID } from './config.js'
export type { GatewayIosConfig } from './config.js'

// Logger
export { createLogger } from './logger.js'

// Frozen mobile DTO contracts
export type {
  MobileSessionMode,
  MobileSessionStatus,
  MobileSessionSummary,
  MobileSessionCapabilities,
  MobileSessionIndex,
  TimelineFrameKind,
  TimelineBlockKind,
  SourceEventCitation,
  TimelineBlock,
  FrameAction,
  TimelineFrame,
  SnapshotHighWater,
  HistoryCursor,
  HistoryPage,
  SnapshotMessage,
  FrameMessage,
  HrcEventMessage,
  ControlMessage,
  GatewayWsMessage,
  MobileFence,
  InputRequest,
  InputResponse,
  InterruptRequest,
  InterruptResponse,
} from './contracts.js'

// Reducer input interface (consumed by P2)
export type { ReducerInput } from './types.js'

// Event reducer (P2)
export {
  createReducerState,
  reduce,
} from './event-reducer.js'
export type {
  FrameState,
  ReducerState,
  FrameUpdate,
  ReducerResult,
} from './event-reducer.js'

// Frame projector (P2)
export { projectTimeline, projectIncremental } from './frame-projector.js'
export type { ProjectionResult } from './frame-projector.js'

// Health handler (P5)
export { handleHealth } from './health.js'
export type { GatewayHealthResponse } from './health.js'

// Session index (P5)
export { createSessionIndex } from './session-index.js'
export type { SessionIndexDeps } from './session-index.js'

// Routes (P5/P4/P6 + P3 WS)
export {
  createGatewayIosRoutes,
  createGatewayIosFetchHandler,
  createGatewayIosWsHandlers,
  createGatewayIosServeConfig,
} from './routes.js'
export type { GatewayIosRoute, GatewayIosRouteDeps, WsData } from './routes.js'

// Event pump (P3 — shared by timeline-ws and diagnostics-ws)
export { runEventPump } from './event-pump.js'
export type { EventPumpHrcClient, EventPumpOptions, EventPumpResult } from './event-pump.js'

// Event filter (P3)
export {
  isRelevantToSession,
  sessionRefFromEvent,
  matchesCategory,
  matchesEventKind,
} from './event-filter.js'

// Timeline WS (P3)
export { createTimelineWsHandler } from './timeline-ws.js'
export type { TimelineWsData, TimelineWsDeps } from './timeline-ws.js'

// Diagnostics WS (P3)
export { createDiagnosticsWsHandler } from './diagnostics-ws.js'
export type { DiagnosticsWsData, DiagnosticsWsDeps } from './diagnostics-ws.js'
