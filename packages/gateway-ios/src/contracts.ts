/**
 * gateway-ios mobile DTO contracts.
 *
 * FROZEN — this file is the canonical contract surface consumed by P1 through P6.
 * Do not modify existing types after the initial commit without coordinating
 * with all downstream phases.
 *
 * These are mobile UI DTOs, not new HRC events. They project HRC lifecycle
 * events and durable hrcchat messages into SwiftUI-friendly render frames.
 * Canonical HRC eventKind and category values are always preserved in
 * sourceEvents citations.
 */

import type { HrcExecutionMode } from 'hrc-core'

// ---------------------------------------------------------------------------
// Session model
// ---------------------------------------------------------------------------

/**
 * Mobile-facing session mode.
 *
 * 'interactive' — user can send input and interrupt.
 * 'headless'    — read-only bucket for both HRC 'headless' and 'nonInteractive'.
 */
export type MobileSessionMode = 'interactive' | 'headless'

/** Session status as presented to the mobile client. */
export type MobileSessionStatus = 'active' | 'stale' | 'inactive'

/** Summary of a single session in the mobile session index. */
export type MobileSessionSummary = {
  sessionRef: string
  displayRef: string
  title: string
  mode: MobileSessionMode
  executionMode: HrcExecutionMode
  status: MobileSessionStatus
  hostSessionId: string
  generation: number
  runtimeId: string | null
  activeTurnId: string | null
  lastHrcSeq: number
  lastMessageSeq: number
  lastActivityAt: string | null
  capabilities: MobileSessionCapabilities
}

/** Capabilities available for a session in its current state. */
export type MobileSessionCapabilities = {
  input: boolean
  interrupt: boolean
  launchHeadlessTurn: boolean
  history: boolean
}

/** Aggregate session index returned by GET /v1/sessions. */
export type MobileSessionIndex = {
  refreshedAt: string
  counts: {
    all: number
    interactive: number
    headless: number
    active: number
    stale: number
    inactive: number
  }
  sessions: MobileSessionSummary[]
}

// ---------------------------------------------------------------------------
// Timeline frame kinds and block kinds
// ---------------------------------------------------------------------------

/** Discriminated union of mobile timeline frame kinds. */
export type TimelineFrameKind =
  | 'user_prompt'
  | 'assistant_message'
  | 'tool_call'
  | 'tool_result'
  | 'tool_batch'
  | 'patch_summary'
  | 'diff_summary'
  | 'turn_status'
  | 'session_status'
  | 'input_ack'
  | 'error'

/** Discriminated union of render block kinds within a frame. */
export type TimelineBlockKind =
  | 'markdown'
  | 'mono'
  | 'tool_call'
  | 'tool_result'
  | 'command_ledger'
  | 'patch_summary'
  | 'diff_summary'
  | 'status'
  | 'raw_json'

// ---------------------------------------------------------------------------
// Source event citation
// ---------------------------------------------------------------------------

/** Citation linking a frame back to its canonical HRC source event. */
export type SourceEventCitation = {
  hrcSeq: number
  eventKind: string
}

// ---------------------------------------------------------------------------
// Timeline blocks
// ---------------------------------------------------------------------------

/** A single render block within a timeline frame. */
export type TimelineBlock = {
  kind: TimelineBlockKind
  text?: string | undefined
  language?: string | undefined
  toolName?: string | undefined
  toolUseId?: string | undefined
  status?: string | undefined
  payload?: unknown | undefined
}

// ---------------------------------------------------------------------------
// Timeline frame
// ---------------------------------------------------------------------------

/** A render action attached to a frame (e.g. retry, copy, expand). */
export type FrameAction = {
  actionId: string
  label: string
  enabled: boolean
}

/** A single timeline frame — the primary mobile UI update unit. */
export type TimelineFrame = {
  frameId: string
  frameSeq: number
  lastHrcSeq: number
  lastMessageSeq: number | null
  sessionRef: string
  mode: MobileSessionMode
  frameKind: TimelineFrameKind
  sourceEvents: SourceEventCitation[]
  blocks: TimelineBlock[]
  actions: FrameAction[]
  runId?: string | undefined
  turnId?: string | undefined
  ts: string
}

// ---------------------------------------------------------------------------
// Snapshot high-water
// ---------------------------------------------------------------------------

/** Replay cursor representing the latest consumed sequence numbers. */
export type SnapshotHighWater = {
  hrcSeq: number
  messageSeq: number
}

// ---------------------------------------------------------------------------
// History page
// ---------------------------------------------------------------------------

/** Cursor for paginating timeline history. */
export type HistoryCursor = {
  hrcSeq: number
  messageSeq: number
}

/** A page of timeline history returned by GET /v1/history or in the snapshot. */
export type HistoryPage = {
  frames: TimelineFrame[]
  oldestCursor: HistoryCursor
  newestCursor: HistoryCursor
  hasMoreBefore: boolean
}

// ---------------------------------------------------------------------------
// WebSocket message types (discriminated union on 'type')
// ---------------------------------------------------------------------------

/** Initial snapshot sent on WebSocket open. */
export type SnapshotMessage = {
  type: 'snapshot'
  session: MobileSessionSummary
  snapshotHighWater: SnapshotHighWater
  history: HistoryPage
}

/** Live frame update sent after the snapshot. */
export type FrameMessage = {
  type: 'frame'
  frame: TimelineFrame
}

/** Raw HRC event forwarded for diagnostics / raw event mode. */
export type HrcEventMessage = {
  type: 'hrc_event'
  hrcSeq: number
  streamSeq: number
  eventKind: string
  category: string
  ts: string
  payload: unknown
}

/** Gateway control messages (session state changes, errors). */
export type ControlMessage =
  | { type: 'sessions_refreshed'; refreshedAt: string }
  | { type: 'session_updated'; session: MobileSessionSummary }
  | { type: 'error'; code: string; message: string }
  | { type: 'ping' }
  | { type: 'pong' }

/** Union of all WebSocket message types from gateway to client. */
export type GatewayWsMessage = SnapshotMessage | FrameMessage | HrcEventMessage | ControlMessage

// ---------------------------------------------------------------------------
// Input / interrupt request/response DTOs
// ---------------------------------------------------------------------------

/** Freshness fences for input and interrupt requests. */
export type MobileFence = {
  expectedHostSessionId?: string | undefined
  expectedGeneration?: number | undefined
}

/** POST /v1/input request body. */
export type InputRequest = {
  sessionRef: string
  clientInputId: string
  text: string
  enter: boolean
  fences: MobileFence
}

/** POST /v1/input response body. */
export type InputResponse =
  | { ok: true; clientInputId: string; acceptedAt: string }
  | { ok: false; clientInputId: string; code: string; message: string }

/** POST /v1/interrupt request body. */
export type InterruptRequest = {
  sessionRef: string
  clientInputId: string
  fences: MobileFence
}

/** POST /v1/interrupt response body. */
export type InterruptResponse =
  | { ok: true; clientInputId: string }
  | { ok: false; clientInputId: string; code: string; message: string }
