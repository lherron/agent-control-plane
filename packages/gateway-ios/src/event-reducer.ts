/**
 * Pure event reducer: (prevState, input) → { state, frameUpdates }.
 *
 * Consumes ReducerInput (HRC lifecycle events and durable hrcchat messages)
 * and produces timeline frame mutations. Idempotent under replay/double-delivery.
 *
 * Frame identity rules (MUST be precise):
 * - assistant_message: key = runId + messageId + role; fallback runId + role + 'assistant_message'
 * - tool_call: key = runId + toolUseId; tool_result UPDATES existing tool_call frame
 * - user_prompt: key = runId + 'user_prompt' + messageId (or hrcSeq if no messageId)
 * - turn_status: key = runId + 'turn_status'
 * - session_status: key = sessionRef + 'session_status'
 * - input_ack: key = runId + 'input_ack' + hrcSeq
 *
 * Every frame.sourceEvents preserves canonical HRC eventKind and category.
 * NEVER rename eventKinds or invent new categories.
 */

import type { HrcLifecycleEvent } from 'hrc-core'

import type {
  FrameAction,
  SourceEventCitation,
  TimelineBlock,
  TimelineBlockKind,
  TimelineFrame,
  TimelineFrameKind,
} from './contracts.js'
import type { ReducerInput } from './types.js'

// ---------------------------------------------------------------------------
// Reducer state types
// ---------------------------------------------------------------------------

/** Per-frame mutable state held by the reducer between inputs. */
export type FrameState = {
  frame: TimelineFrame
  /** Set of hrcSeq values already applied — used for idempotent dedup. */
  appliedHrcSeqs: Set<number>
}

/** Full reducer state: keyed frames + monotonic frame counter. */
export type ReducerState = {
  /** Map from frame identity key → FrameState. */
  frames: Map<string, FrameState>
  /** Next frameSeq to assign. */
  nextFrameSeq: number
  /** Highest hrcSeq seen (for high-water tracking). */
  highWaterHrcSeq: number
  /** Highest messageSeq seen (for high-water tracking). */
  highWaterMessageSeq: number
}

/** A frame update emitted by the reducer for a single input. */
export type FrameUpdate =
  | { action: 'create'; frame: TimelineFrame }
  | { action: 'update'; frame: TimelineFrame }
  | { action: 'noop' }

/** Result of applying one input to the reducer. */
export type ReducerResult = {
  state: ReducerState
  frameUpdates: FrameUpdate[]
}

// ---------------------------------------------------------------------------
// State factory
// ---------------------------------------------------------------------------

/** Create a fresh, empty reducer state. */
export function createReducerState(): ReducerState {
  return { frames: new Map(), nextFrameSeq: 1, highWaterHrcSeq: 0, highWaterMessageSeq: 0 }
}

// ---------------------------------------------------------------------------
// Internal: frame identity key builders
// ---------------------------------------------------------------------------

function assistantMessageKey(runId: string, role: string, messageId: string | undefined): string {
  return messageId ? `${runId}:${messageId}:${role}` : `${runId}:${role}:assistant_message`
}

function toolKey(runId: string, toolUseId: string): string {
  return `${runId}:tool:${toolUseId}`
}

function userPromptKey(runId: string, messageId: string | undefined, hrcSeq: number): string {
  return `${runId}:user_prompt:${messageId ?? String(hrcSeq)}`
}

function turnStatusKey(runId: string): string {
  return `${runId}:turn_status`
}

function sessionStatusKey(sessionRef: string): string {
  return `${sessionRef}:session_status`
}

function inputAckKey(runId: string, hrcSeq: number): string {
  return `${runId}:input_ack:${hrcSeq}`
}

// ---------------------------------------------------------------------------
// Internal: helpers
// ---------------------------------------------------------------------------

function sessionRefFromEvent(event: HrcLifecycleEvent): string {
  return `agent:${event.scopeRef}/lane:${event.laneRef}`
}

function makeFrame(
  frameSeq: number,
  frameId: string,
  sessionRef: string,
  frameKind: TimelineFrameKind,
  event: HrcLifecycleEvent,
  blocks: TimelineBlock[],
  actions: FrameAction[] = []
): TimelineFrame {
  return {
    frameId,
    frameSeq,
    lastHrcSeq: event.hrcSeq,
    lastMessageSeq: null,
    sessionRef,
    mode: 'interactive',
    frameKind,
    sourceEvents: [{ hrcSeq: event.hrcSeq, eventKind: event.eventKind }],
    blocks,
    actions,
    runId: event.runId ?? undefined,
    turnId: undefined,
    ts: event.ts,
  }
}

// ---------------------------------------------------------------------------
// Upsert helper — eliminates repeated idempotency/create/update boilerplate
// ---------------------------------------------------------------------------

type UpsertOpts = {
  state: ReducerState
  key: string
  hrcSeq: number
  sessionRef: string
  frameKind: TimelineFrameKind
  event: HrcLifecycleEvent
  citation: SourceEventCitation
  blocks: TimelineBlock[]
  /** Optional runId override for the frame (set to undefined to skip). */
  runId?: string | undefined
  /** Called when updating an existing frame — mutate blocks/etc before the update is emitted. */
  onUpdate?: ((fs: FrameState) => void) | undefined
}

function upsertFrame(opts: UpsertOpts): FrameUpdate {
  const existing = opts.state.frames.get(opts.key)

  if (existing) {
    if (existing.appliedHrcSeqs.has(opts.hrcSeq)) return { action: 'noop' }

    existing.appliedHrcSeqs.add(opts.hrcSeq)
    existing.frame.lastHrcSeq = opts.hrcSeq
    existing.frame.sourceEvents.push(opts.citation)
    existing.frame.ts = opts.event.ts

    if (opts.onUpdate) opts.onUpdate(existing)
    else existing.frame.blocks = opts.blocks

    return { action: 'update', frame: existing.frame }
  }

  const frame = makeFrame(
    opts.state.nextFrameSeq++,
    opts.key,
    opts.sessionRef,
    opts.frameKind,
    opts.event,
    opts.blocks
  )
  if (opts.runId !== undefined) frame.runId = opts.runId

  opts.state.frames.set(opts.key, { frame, appliedHrcSeqs: new Set([opts.hrcSeq]) })
  return { action: 'create', frame }
}

// ---------------------------------------------------------------------------
// Typed payload extraction helpers (zero `any`)
// ---------------------------------------------------------------------------

type TurnMessagePayload = {
  type: string
  message: { role: string; content: string | Array<{ type: string; text?: string }> }
  messageId?: string
}

type ToolCallPayload = {
  type: string
  toolUseId: string
  toolName: string
  input: Record<string, unknown>
}

type ToolResultPayload = {
  type: string
  toolUseId: string
  toolName: string
  result: { content: Array<{ type: string; text?: string }> }
  isError?: boolean
}

type UserPromptPayload = {
  type: string
  message: { role: string; content: string | Array<{ type: string; text?: string }> }
}

function isTurnMessagePayload(p: unknown): p is TurnMessagePayload {
  if (!p || typeof p !== 'object') return false
  const obj = p as Record<string, unknown>
  return (
    typeof obj['type'] === 'string' && obj['message'] != null && typeof obj['message'] === 'object'
  )
}

function isToolCallPayload(p: unknown): p is ToolCallPayload {
  if (!p || typeof p !== 'object') return false
  const obj = p as Record<string, unknown>
  return typeof obj['toolUseId'] === 'string' && typeof obj['toolName'] === 'string'
}

function isToolResultPayload(p: unknown): p is ToolResultPayload {
  if (!p || typeof p !== 'object') return false
  const obj = p as Record<string, unknown>
  return (
    typeof obj['toolUseId'] === 'string' &&
    typeof obj['toolName'] === 'string' &&
    obj['result'] != null
  )
}

function isUserPromptPayload(p: unknown): p is UserPromptPayload {
  if (!p || typeof p !== 'object') return false
  const obj = p as Record<string, unknown>
  return obj['message'] != null && typeof obj['message'] === 'object'
}

function extractTextContent(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === 'string') return content
  return content
    .filter(
      (b): b is { type: string; text: string } => b.type === 'text' && typeof b.text === 'string'
    )
    .map((b) => b.text)
    .join('')
}

function blocksFromContent(
  content: string | Array<{ type: string; text?: string }>
): TimelineBlock[] {
  if (typeof content === 'string') return [{ kind: 'markdown' as TimelineBlockKind, text: content }]
  return content
    .filter(
      (b): b is { type: string; text: string } => b.type === 'text' && typeof b.text === 'string'
    )
    .map((b) => ({ kind: 'markdown' as TimelineBlockKind, text: b.text }))
}

// ---------------------------------------------------------------------------
// Per-category event reducers (split for cognitive complexity)
// ---------------------------------------------------------------------------

const SESSION_STATUS_TEXT: Record<string, string> = {
  'session.created': 'Session created',
  'session.resolved': 'Session resolved',
  'session.generation_auto_rotated': 'Session generation rotated',
  'session.continuation_dropped': 'Session continuation dropped',
}

function reduceSessionEvent(
  state: ReducerState,
  event: HrcLifecycleEvent,
  sessionRef: string,
  citation: SourceEventCitation
): FrameUpdate {
  const isStale = event.eventKind === 'session.generation_auto_rotated'
  const text = SESSION_STATUS_TEXT[event.eventKind] ?? event.eventKind
  const blocks: TimelineBlock[] = [{ kind: 'status', status: isStale ? 'stale' : 'active', text }]

  return upsertFrame({
    state,
    key: sessionStatusKey(sessionRef),
    hrcSeq: event.hrcSeq,
    sessionRef,
    frameKind: 'session_status',
    event,
    citation,
    blocks,
    onUpdate: isStale
      ? (fs) => {
          fs.frame.blocks = blocks
        }
      : undefined,
  })
}

function reduceRuntimeEvent(
  state: ReducerState,
  event: HrcLifecycleEvent,
  sessionRef: string,
  citation: SourceEventCitation
): FrameUpdate {
  const action = event.eventKind.split('.')[1] ?? event.eventKind
  const statusText = `Runtime ${action}`
  const statusValue =
    event.eventKind === 'runtime.stale' || event.eventKind === 'runtime.dead'
      ? 'stale'
      : event.eventKind === 'runtime.terminated'
        ? 'inactive'
        : 'active'
  const blocks: TimelineBlock[] = [{ kind: 'status', status: statusValue, text: statusText }]

  return upsertFrame({
    state,
    key: sessionStatusKey(sessionRef),
    hrcSeq: event.hrcSeq,
    sessionRef,
    frameKind: 'session_status',
    event,
    citation,
    blocks,
  })
}

function reduceInterrupted(
  state: ReducerState,
  event: HrcLifecycleEvent,
  sessionRef: string,
  citation: SourceEventCitation
): FrameUpdate {
  const runId = event.runId ?? 'no-run'
  const blocks: TimelineBlock[] = [
    { kind: 'status', status: 'interrupted', text: 'Turn interrupted' },
  ]
  return upsertFrame({
    state,
    key: turnStatusKey(runId),
    hrcSeq: event.hrcSeq,
    sessionRef,
    frameKind: 'turn_status',
    event,
    citation,
    blocks,
    runId: runId !== 'no-run' ? runId : undefined,
  })
}

function reduceContextCleared(
  state: ReducerState,
  event: HrcLifecycleEvent,
  sessionRef: string,
  citation: SourceEventCitation
): FrameUpdate {
  const blocks: TimelineBlock[] = [
    { kind: 'status', status: 'stale', text: 'Context cleared — stale composer prompt' },
  ]
  return upsertFrame({
    state,
    key: sessionStatusKey(sessionRef),
    hrcSeq: event.hrcSeq,
    sessionRef,
    frameKind: 'session_status',
    event,
    citation,
    blocks,
  })
}

function reduceTurnLifecycle(
  state: ReducerState,
  event: HrcLifecycleEvent,
  sessionRef: string,
  citation: SourceEventCitation
): FrameUpdate {
  const runId = event.runId ?? 'no-run'
  const isCompleted = event.eventKind === 'turn.completed'
  const statusText = isCompleted
    ? 'Turn completed'
    : event.eventKind === 'turn.accepted'
      ? 'Turn accepted'
      : 'Turn running'
  const statusValue = isCompleted ? 'completed' : 'running'
  const blocks: TimelineBlock[] = [{ kind: 'status', status: statusValue, text: statusText }]

  return upsertFrame({
    state,
    key: turnStatusKey(runId),
    hrcSeq: event.hrcSeq,
    sessionRef,
    frameKind: 'turn_status',
    event,
    citation,
    blocks,
    runId: runId !== 'no-run' ? runId : undefined,
  })
}

function reduceUserPrompt(
  state: ReducerState,
  event: HrcLifecycleEvent,
  sessionRef: string,
  citation: SourceEventCitation
): FrameUpdate {
  const runId = event.runId ?? 'no-run'
  let messageId: string | undefined
  let textContent = ''

  if (isUserPromptPayload(event.payload)) {
    const msgObj = event.payload as UserPromptPayload & { messageId?: string }
    messageId = msgObj.messageId
    textContent = extractTextContent(event.payload.message.content)
  }

  return upsertFrame({
    state,
    key: userPromptKey(runId, messageId, event.hrcSeq),
    hrcSeq: event.hrcSeq,
    sessionRef,
    frameKind: 'user_prompt',
    event,
    citation,
    blocks: [{ kind: 'markdown', text: textContent }],
    runId: runId !== 'no-run' ? runId : undefined,
    onUpdate: (_fs) => {
      // user_prompt is immutable once created — no block changes on update
    },
  })
}

function reduceTurnMessage(
  state: ReducerState,
  event: HrcLifecycleEvent,
  sessionRef: string,
  citation: SourceEventCitation
): FrameUpdate {
  const payload = event.payload
  if (!isTurnMessagePayload(payload)) return { action: 'noop' }

  const runId = event.runId ?? 'no-run'
  const role = payload.message.role
  const messageId = payload.messageId
  const key = assistantMessageKey(runId, role, messageId)

  return upsertFrame({
    state,
    key,
    hrcSeq: event.hrcSeq,
    sessionRef,
    frameKind: 'assistant_message',
    event,
    citation,
    blocks: blocksFromContent(payload.message.content),
    runId: runId !== 'no-run' ? runId : undefined,
    onUpdate: (fs) => {
      // APPEND/MERGE blocks in hrcSeq order
      fs.frame.blocks.push(...blocksFromContent(payload.message.content))
    },
  })
}

function reduceToolCall(
  state: ReducerState,
  event: HrcLifecycleEvent,
  sessionRef: string,
  citation: SourceEventCitation
): FrameUpdate {
  const payload = event.payload
  if (!isToolCallPayload(payload)) return { action: 'noop' }

  const runId = event.runId ?? 'no-run'
  const key = toolKey(runId, payload.toolUseId)
  const callBlock: TimelineBlock = {
    kind: 'tool_call',
    toolName: payload.toolName,
    toolUseId: payload.toolUseId,
    text: JSON.stringify(payload.input),
  }

  return upsertFrame({
    state,
    key,
    hrcSeq: event.hrcSeq,
    sessionRef,
    frameKind: 'tool_call',
    event,
    citation,
    blocks: [callBlock],
    runId: runId !== 'no-run' ? runId : undefined,
    onUpdate: (fs) => {
      // Fill in tool_call block if this was a placeholder from result-first
      if (!fs.frame.blocks.some((b) => b.kind === 'tool_call')) {
        fs.frame.blocks.unshift(callBlock)
      }
    },
  })
}

function reduceToolResult(
  state: ReducerState,
  event: HrcLifecycleEvent,
  sessionRef: string,
  citation: SourceEventCitation
): FrameUpdate {
  const payload = event.payload
  if (!isToolResultPayload(payload)) return { action: 'noop' }

  const runId = event.runId ?? 'no-run'
  const key = toolKey(runId, payload.toolUseId)

  const resultText = payload.result.content
    .filter(
      (b): b is { type: string; text: string } => b.type === 'text' && typeof b.text === 'string'
    )
    .map((b) => b.text)
    .join('')

  const resultBlock: TimelineBlock = {
    kind: 'tool_result',
    toolName: payload.toolName,
    toolUseId: payload.toolUseId,
    text: resultText,
    status: payload.isError ? 'error' : 'success',
  }

  return upsertFrame({
    state,
    key,
    hrcSeq: event.hrcSeq,
    sessionRef,
    frameKind: 'tool_call',
    event,
    citation,
    blocks: [resultBlock], // placeholder: only result block; tool_call prepended when call arrives
    runId: runId !== 'no-run' ? runId : undefined,
    onUpdate: (fs) => {
      fs.frame.blocks.push(resultBlock)
    },
  })
}

function reduceInflight(
  state: ReducerState,
  event: HrcLifecycleEvent,
  sessionRef: string,
  citation: SourceEventCitation
): FrameUpdate {
  const runId = event.runId ?? 'no-run'
  const isAccepted = event.eventKind === 'inflight.accepted'
  const blocks: TimelineBlock[] = [
    {
      kind: 'status',
      status: isAccepted ? 'accepted' : 'rejected',
      text: isAccepted ? 'Input accepted' : 'Input rejected',
    },
  ]

  return upsertFrame({
    state,
    key: inputAckKey(runId, event.hrcSeq),
    hrcSeq: event.hrcSeq,
    sessionRef,
    frameKind: 'input_ack',
    event,
    citation,
    blocks,
    runId: runId !== 'no-run' ? runId : undefined,
    onUpdate: (_fs) => {
      // input_ack is immutable once created
    },
  })
}

// ---------------------------------------------------------------------------
// Core reducer: dispatch to per-category handlers
// ---------------------------------------------------------------------------

function reduceEvent(state: ReducerState, event: HrcLifecycleEvent): FrameUpdate[] {
  const sessionRef = sessionRefFromEvent(event)

  if (event.hrcSeq > state.highWaterHrcSeq) {
    state.highWaterHrcSeq = event.hrcSeq
  }

  const citation: SourceEventCitation = { hrcSeq: event.hrcSeq, eventKind: event.eventKind }

  switch (event.eventKind) {
    case 'session.created':
    case 'session.resolved':
    case 'session.generation_auto_rotated':
    case 'session.continuation_dropped':
      return [reduceSessionEvent(state, event, sessionRef, citation)]

    case 'runtime.created':
    case 'runtime.ensured':
    case 'runtime.restarted':
    case 'runtime.adopted':
    case 'runtime.terminated':
    case 'runtime.stale':
    case 'runtime.dead':
      return [reduceRuntimeEvent(state, event, sessionRef, citation)]

    case 'runtime.interrupted':
      return [reduceInterrupted(state, event, sessionRef, citation)]

    case 'context.cleared':
      return [reduceContextCleared(state, event, sessionRef, citation)]

    case 'turn.accepted':
    case 'turn.started':
    case 'turn.completed':
      return [reduceTurnLifecycle(state, event, sessionRef, citation)]

    case 'turn.user_prompt':
      return [reduceUserPrompt(state, event, sessionRef, citation)]

    case 'turn.message':
      return [reduceTurnMessage(state, event, sessionRef, citation)]

    case 'turn.tool_call':
      return [reduceToolCall(state, event, sessionRef, citation)]

    case 'turn.tool_result':
      return [reduceToolResult(state, event, sessionRef, citation)]

    case 'inflight.accepted':
    case 'inflight.rejected':
      return [reduceInflight(state, event, sessionRef, citation)]

    default:
      return [{ action: 'noop' }]
  }
}

// ---------------------------------------------------------------------------
// Core reducer: process a single hrcchat message
// ---------------------------------------------------------------------------

function reduceMessage(
  state: ReducerState,
  message: { messageSeq: number; messageId: string; body: string; createdAt: string }
): FrameUpdate[] {
  if (message.messageSeq > state.highWaterMessageSeq) {
    state.highWaterMessageSeq = message.messageSeq
  }
  return [{ action: 'noop' }]
}

// ---------------------------------------------------------------------------
// Public API: apply one ReducerInput
// ---------------------------------------------------------------------------

/**
 * Pure reducer function.
 *
 * Apply a single ReducerInput to the state and return the updated state
 * plus frame updates. The caller is responsible for managing state lifecycle.
 *
 * Guarantees:
 * - Idempotent under replay/double-delivery of the same hrcSeq.
 * - Never duplicates frames on replayed events.
 * - Never coalesces across runs or roles.
 * - Every frame.sourceEvents preserves canonical HRC eventKind and category.
 */
export function reduce(state: ReducerState, input: ReducerInput): ReducerResult {
  let frameUpdates: FrameUpdate[]

  switch (input.kind) {
    case 'event':
      frameUpdates = reduceEvent(state, input.event)
      break
    case 'message':
      frameUpdates = reduceMessage(state, input.message)
      break
    default: {
      const _exhaustive: never = input
      throw new Error(`Unhandled ReducerInput kind: ${JSON.stringify(_exhaustive)}`)
    }
  }

  return { state, frameUpdates }
}
