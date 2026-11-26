import { formatScopeHandle, parseScopeRef } from 'agent-scope'
import { type HrcLifecycleEvent, splitSessionRef } from 'hrc-core'
import { type CollaborationMessage, formatCollaborationMessage } from 'wrkq-lib'
import type { AcpHrcClient, ResolvedAcpServerDeps } from '../deps.js'
import { hasHrcEvidenceOrigin } from '../hrc-evidence-origin.js'
import { badRequest, json } from '../http.js'
import {
  MobileTimelineCursorInvalidError,
  MobileTimelineItemOversizeError,
  MobileTimelineMalformedCursorError,
  MobileTimelineSourcePositionExhaustedError,
  createMobileTimelineProjector,
} from '../mobile-timeline-projector.js'
import { isRecord, readNonBlankStringField } from '../parsers/body.js'
import type { RouteHandler } from '../routing/route-context.js'
import { requireHrcClient } from './mobile-hrc.js'
import {
  federatedSessionReadDeclared,
  isRemoteProjectionSource,
  remoteControlUnavailable,
  resolveMobileSessionForRead,
  sessionHomeRefusal,
} from './mobile-session-access.js'
import { type MobileSessionMode, sessionRef } from './mobile-session-projection.js'

export type MobileTimelineFrame = {
  frameId: string
  frameSeq: number
  lastHrcSeq: number
  lastMessageSeq?: number | undefined
  sessionRef: string
  mode: MobileSessionMode
  frameKind:
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
  sourceEvents: Array<{ hrcSeq: number; eventKind: string }>
  blocks: Array<{
    kind:
      | 'markdown'
      | 'mono'
      | 'tool_call'
      | 'tool_result'
      | 'command_ledger'
      | 'patch_summary'
      | 'diff_summary'
      | 'status'
      | 'raw_json'
    text?: string | undefined
    language?: string | undefined
    toolName?: string | undefined
    toolUseId?: string | undefined
    status?: string | undefined
    payload?: unknown
  }>
  actions: Array<{ actionId: string; label: string; enabled: boolean }>
  runId?: string | undefined
  turnId?: string | undefined
  ts: string
}

function frameKind(event: HrcLifecycleEvent): MobileTimelineFrame['frameKind'] {
  if (event.errorCode !== undefined || event.category === 'inflight') return 'error'
  if (event.category === 'session') return 'session_status'
  if (event.category === 'turn' || event.category === 'runtime' || event.category === 'launch') {
    return 'turn_status'
  }
  return 'session_status'
}

function frameText(event: HrcLifecycleEvent): string {
  return `${event.eventKind} · ${event.category}`
}

export function projectFrame(
  event: HrcLifecycleEvent,
  mode: MobileSessionMode = 'interactive'
): MobileTimelineFrame {
  return {
    frameId: `hrc-${event.hrcSeq}`,
    frameSeq: event.hrcSeq,
    lastHrcSeq: event.hrcSeq,
    sessionRef: sessionRef(event.scopeRef, event.laneRef),
    mode,
    frameKind: frameKind(event),
    sourceEvents: [{ hrcSeq: event.hrcSeq, eventKind: event.eventKind }],
    blocks: [
      {
        kind: 'status',
        text: frameText(event),
        status: event.eventKind,
      },
      {
        kind: 'raw_json',
        language: 'json',
        payload: event.payload,
      },
    ],
    actions: [],
    ...(event.runId !== undefined ? { runId: event.runId } : {}),
    ts: event.ts,
  }
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function projectCollaborationMessage(
  message: CollaborationMessage,
  sessionRefValue: string,
  memberRef: string
): MobileTimelineFrame {
  const frameKind: MobileTimelineFrame['frameKind'] =
    message.recipient?.scopeRef === memberRef || message.sender.principalRef === 'agent:lance'
      ? 'user_prompt'
      : 'assistant_message'

  return {
    frameId: `msg-${message.messageId}`,
    frameSeq: message.messageSeq,
    lastHrcSeq: 0,
    lastMessageSeq: message.messageSeq,
    sessionRef: sessionRefValue,
    mode: 'interactive',
    frameKind,
    sourceEvents: [],
    blocks: [
      {
        kind: 'markdown',
        text: formatCollaborationMessage(message),
        payload: {
          envelopeId: message.messageId,
          roomKey: message.roomKey,
          sender: message.sender,
          recipient: message.recipient,
          obligation: message.obligation,
          state: message.state,
        },
      },
    ],
    actions: [],
    ts: message.createdAt,
  }
}

function messageContent(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined
  const direct =
    readNonBlankStringField(payload, 'text') ??
    readNonBlankStringField(payload, 'content') ??
    readNonBlankStringField(payload, 'message') ??
    readNonBlankStringField(payload, 'prompt') ??
    readNonBlankStringField(payload, 'summary') ??
    readNonBlankStringField(payload, 'output')
  if (direct !== undefined) return direct

  const message = payload['message']
  if (isRecord(message)) {
    const content = message['content']
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      const text = content
        .map((block) => (isRecord(block) ? readNonBlankStringField(block, 'text') : undefined))
        .filter((part): part is string => part !== undefined)
        .join('')
      if (text.trim().length > 0) return text
    }
  }
  return undefined
}

function toolText(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined
  const input = payload['input']
  if (isRecord(input)) return JSON.stringify(input)
  const result = payload['result']
  if (isRecord(result)) {
    const content = result['content']
    if (Array.isArray(content)) {
      const text = content
        .map((block) => (isRecord(block) ? readNonBlankStringField(block, 'text') : undefined))
        .filter((part): part is string => part !== undefined)
        .join('')
      if (text.trim().length > 0) return text
    }
  }
  return (
    readNonBlankStringField(payload, 'command') ??
    readNonBlankStringField(payload, 'cmd') ??
    readNonBlankStringField(payload, 'output')
  )
}

function toolStatus(payload: unknown, fallback: string): string {
  if (!isRecord(payload)) return fallback
  if (typeof payload['isError'] === 'boolean')
    return payload['isError'] === true ? 'error' : 'success'
  return (
    readNonBlankStringField(payload, 'status') ??
    readNonBlankStringField(payload, 'state') ??
    fallback
  )
}

export function projectPrimaryEvent(
  event: HrcLifecycleEvent,
  mode: MobileSessionMode = 'interactive'
): MobileTimelineFrame | undefined {
  if (event.errorCode !== undefined) {
    return projectFrame(event, mode)
  }

  const base = {
    frameId: `hrc-${event.hrcSeq}`,
    frameSeq: event.hrcSeq,
    lastHrcSeq: event.hrcSeq,
    sessionRef: sessionRef(event.scopeRef, event.laneRef),
    mode,
    sourceEvents: [{ hrcSeq: event.hrcSeq, eventKind: event.eventKind }],
    actions: [],
    ...(event.runId !== undefined ? { runId: event.runId } : {}),
    ts: event.ts,
  }

  switch (event.eventKind) {
    case 'turn.user_prompt': {
      const text = messageContent(event.payload)
      if (text === undefined) return undefined
      const trimmed = text.trim()
      if (
        trimmed === 'cody' ||
        trimmed.startsWith('You are Cody,') ||
        trimmed.startsWith('[DM #')
      ) {
        return undefined
      }
      return {
        ...base,
        frameKind: 'user_prompt',
        blocks: [{ kind: 'markdown', text, payload: event.payload }],
      }
    }
    case 'turn.message': {
      const text = messageContent(event.payload)
      if (text === undefined) return undefined
      return {
        ...base,
        frameKind: 'assistant_message',
        blocks: [{ kind: 'markdown', text, payload: event.payload }],
      }
    }
    case 'turn.tool_call': {
      const payload = isRecord(event.payload) ? event.payload : {}
      return {
        ...base,
        frameKind: 'tool_call',
        blocks: [
          {
            kind: 'tool_call',
            text: toolText(event.payload),
            toolName:
              readNonBlankStringField(payload, 'toolName') ??
              readNonBlankStringField(payload, 'tool'),
            toolUseId: readNonBlankStringField(payload, 'toolUseId'),
            status: toolStatus(event.payload, 'running'),
            payload: event.payload,
          },
        ],
      }
    }
    case 'turn.tool_result': {
      const payload = isRecord(event.payload) ? event.payload : {}
      return {
        ...base,
        frameKind: 'tool_result',
        blocks: [
          {
            kind: 'tool_result',
            text: toolText(event.payload),
            toolName:
              readNonBlankStringField(payload, 'toolName') ??
              readNonBlankStringField(payload, 'tool'),
            toolUseId: readNonBlankStringField(payload, 'toolUseId'),
            status: toolStatus(event.payload, 'success'),
            payload: event.payload,
          },
        ],
      }
    }
    case 'runtime.interrupted':
      return {
        ...base,
        frameKind: 'turn_status',
        blocks: [
          {
            kind: 'status',
            text: 'Turn interrupted',
            status: event.eventKind,
            payload: event.payload,
          },
        ],
      }
    case 'runtime.stale':
    case 'context.cleared':
      return {
        ...base,
        frameKind: 'session_status',
        blocks: [
          {
            kind: 'status',
            text: frameText(event),
            status: event.eventKind,
            payload: event.payload,
          },
        ],
      }
    case 'launch.exited': {
      const payload = isRecord(event.payload) ? event.payload : {}
      const exitCode = numberField(payload, 'exitCode')
      if (exitCode === undefined || exitCode === 0) return undefined
      return {
        ...base,
        frameKind: 'error',
        blocks: [
          {
            kind: 'status',
            text: `Launch exited with code ${exitCode}`,
            status: event.eventKind,
            payload: event.payload,
          },
        ],
      }
    }
    default:
      return undefined
  }
}

export const MOBILE_COLLABORATION_MATCH_WINDOW_MS = 120_000

export type ProjectedCollaborationFrame = {
  frame: MobileTimelineFrame
  message: CollaborationMessage
}

function timelineTimestampDistance(lhs: string, rhs: string): number | undefined {
  const lhsMs = Date.parse(lhs)
  const rhsMs = Date.parse(rhs)
  if (!Number.isFinite(lhsMs) || !Number.isFinite(rhsMs)) return undefined
  return Math.abs(lhsMs - rhsMs)
}

function collaborationMatchesHrcFrame(
  collaboration: ProjectedCollaborationFrame,
  hrcFrame: MobileTimelineFrame
): boolean {
  if (
    collaboration.frame.frameKind !== 'user_prompt' ||
    hrcFrame.frameKind !== 'user_prompt' ||
    collaboration.frame.sessionRef !== hrcFrame.sessionRef
  ) {
    return false
  }
  const distance = timelineTimestampDistance(collaboration.frame.ts, hrcFrame.ts)
  if (distance === undefined || distance > MOBILE_COLLABORATION_MATCH_WINDOW_MS) return false
  return hrcFrame.blocks.some(
    (block) => typeof block.text === 'string' && block.text.includes(collaboration.message.body)
  )
}

export function mergeCollaborationIdentity(
  hrcFrame: MobileTimelineFrame,
  collaboration: ProjectedCollaborationFrame
): MobileTimelineFrame {
  const collaborationPayload = collaboration.frame.blocks.find(
    (block) => block.kind === 'markdown'
  )?.payload
  const collaborationMetadata = isRecord(collaborationPayload) ? collaborationPayload : {}
  const actionsById = new Map(
    [...hrcFrame.actions, ...collaboration.frame.actions].map((action) => [action.actionId, action])
  )
  return {
    ...hrcFrame,
    lastMessageSeq: Math.max(hrcFrame.lastMessageSeq ?? 0, collaboration.message.messageSeq),
    blocks: hrcFrame.blocks.map((block) => ({
      ...block,
      payload: {
        ...(isRecord(block.payload) ? block.payload : {}),
        ...collaborationMetadata,
        envelopeId: collaboration.message.messageId,
        messageSeq: collaboration.message.messageSeq,
      },
    })),
    actions: [...actionsById.values()],
  }
}

export function closestCollaborationMatch(
  hrcFrame: MobileTimelineFrame,
  collaborations: readonly ProjectedCollaborationFrame[]
): ProjectedCollaborationFrame | undefined {
  return collaborations
    .filter((collaboration) => collaborationMatchesHrcFrame(collaboration, hrcFrame))
    .sort((lhs, rhs) => {
      const lhsDistance = timelineTimestampDistance(lhs.frame.ts, hrcFrame.ts) ?? Number.MAX_VALUE
      const rhsDistance = timelineTimestampDistance(rhs.frame.ts, hrcFrame.ts) ?? Number.MAX_VALUE
      return lhsDistance - rhsDistance || lhs.message.messageSeq - rhs.message.messageSeq
    })[0]
}

const mobileTimelineProjectorCache = new WeakMap<
  ResolvedAcpServerDeps,
  ReturnType<typeof createMobileTimelineProjector>
>()

function logicalFrameIdForEvent(event: HrcLifecycleEvent, frame: MobileTimelineFrame): string {
  if (frame.frameKind === 'assistant_message') {
    return `assistant:${event.runId ?? event.runtimeId ?? event.hostSessionId}:${event.generation}`
  }
  if (frame.frameKind === 'tool_call' || frame.frameKind === 'tool_result') {
    const toolUseId = frame.blocks.find((block) => block.toolUseId !== undefined)?.toolUseId
    return `tool:${toolUseId ?? event.runId ?? event.hrcSeq}`
  }
  if (frame.frameKind === 'turn_status') return `turn-status:${event.runId ?? event.hostSessionId}`
  if (frame.frameKind === 'session_status') {
    return `session-status:${event.hostSessionId}:${event.generation}`
  }
  return frame.frameId
}

function immutableCollaborationFrame(
  message: CollaborationMessage,
  sessionRefValue: string,
  memberRef: string
): MobileTimelineFrame {
  const frame = projectCollaborationMessage(message, sessionRefValue, memberRef)
  return {
    ...frame,
    blocks: frame.blocks.map((block) => ({
      ...block,
      text: message.body,
      payload: {
        envelopeId: message.messageId,
        roomKey: message.roomKey,
        sender: message.sender,
        recipient: message.recipient,
        ...(message.taskId !== undefined ? { taskId: message.taskId } : {}),
      },
    })),
  }
}

export function mobileTimelineProjector(deps: ResolvedAcpServerDeps, hrcClient: AcpHrcClient) {
  const cached = mobileTimelineProjectorCache.get(deps)
  if (cached !== undefined) return cached
  if (deps.stateStore === undefined || deps.collaborationLedger === undefined) {
    throw new Error('mobile timeline projection is not configured')
  }
  const projector = createMobileTimelineProjector({
    store: deps.stateStore.mobileTimeline,
    hrcClient,
    collaborationLedger: deps.collaborationLedger,
    projectHrc(event, matchedCollaboration) {
      const projected = projectPrimaryEvent(event)
      if (projected === undefined) return undefined
      const frame =
        matchedCollaboration === undefined
          ? projected
          : mergeCollaborationIdentity(projected, {
              message: matchedCollaboration,
              frame: immutableCollaborationFrame(
                matchedCollaboration,
                projected.sessionRef,
                matchedCollaboration.recipient?.scopeRef ??
                  matchedCollaboration.sender.scopeRef ??
                  'unknown'
              ),
            })
      const statusFrame =
        frame.frameKind === 'turn_status' ||
        frame.frameKind === 'session_status' ||
        frame.frameKind === 'input_ack'
      // Status rows with an evidence origin are history: they append under their
      // own frame id and never replace current status or assert a complete prefix.
      if (statusFrame && hasHrcEvidenceOrigin(event)) {
        return {
          logicalFrameId: frame.frameId,
          operation: 'append',
          payload: { frame: { ...frame, frameSeq: 0 } },
          prefixState: 'unknown',
        }
      }
      return {
        logicalFrameId: logicalFrameIdForEvent(event, frame),
        operation: statusFrame ? 'replace' : 'append',
        payload: { frame: { ...frame, frameSeq: 0 } },
        prefixState:
          frame.frameKind === 'user_prompt' || event.eventKind === 'turn.started'
            ? 'complete'
            : 'unknown',
      }
    },
    projectCollaboration(message) {
      const memberRef = message.recipient?.scopeRef ?? message.sender.scopeRef ?? 'unknown'
      const frame = immutableCollaborationFrame(message, 'agent:unknown/lane:main', memberRef)
      return {
        logicalFrameId: frame.frameId,
        operation: 'append',
        payload: {
          frame: {
            ...frame,
            frameSeq: 0,
            blocks: frame.blocks,
          },
        },
        prefixState: 'complete',
      }
    },
    collaborationMatchesHrc(event, message) {
      const frame = projectPrimaryEvent(event)
      if (frame === undefined) return false
      return collaborationMatchesHrcFrame(
        {
          message,
          frame: immutableCollaborationFrame(
            message,
            frame.sessionRef,
            message.recipient?.scopeRef ?? message.sender.scopeRef ?? 'unknown'
          ),
        },
        frame
      )
    },
  })
  mobileTimelineProjectorCache.set(deps, projector)
  return projector
}

export const handleMobileHistory: RouteHandler = async ({ deps, url }) => {
  const hrcClient = requireHrcClient(deps)
  const remoteSource = isRemoteProjectionSource(url.searchParams.get('sourceKind'))
  if (remoteSource && !(await federatedSessionReadDeclared(hrcClient))) {
    return remoteControlUnavailable()
  }
  const sessionRefValue = url.searchParams.get('sessionRef')?.trim()
  const hostSessionId = url.searchParams.get('hostSessionId')?.trim()
  const generationRaw = url.searchParams.get('generation')
  const generation = generationRaw === null ? Number.NaN : Number(generationRaw)
  if (sessionRefValue === undefined || sessionRefValue.length === 0)
    badRequest('sessionRef is required')
  if (hostSessionId === undefined || hostSessionId.length === 0)
    badRequest('hostSessionId is required')
  if (!Number.isSafeInteger(generation) || generation < 0) {
    badRequest('generation must be a non-negative safe integer')
  }
  if (url.searchParams.has('beforeHrcSeq') || url.searchParams.has('beforeMessageSeq')) {
    badRequest('raw producer cursors are retired; use the opaque cursor parameter')
  }
  const rawLimit = url.searchParams.get('limit')
  const limit = rawLimit === null ? 50 : Number(rawLimit)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    badRequest('limit must be an integer from 1 through 100')
  }
  if (deps.stateStore === undefined || deps.collaborationLedger === undefined) {
    return json(
      { ok: false, code: 'timeline_unavailable', message: 'timeline projection is not configured' },
      503
    )
  }
  if (remoteSource) {
    // T-10418 §5.4: the home must still hold this host session for that scope.
    try {
      await resolveMobileSessionForRead(hrcClient, { hostSessionId, sessionRef: sessionRefValue })
    } catch (error) {
      const refusal = sessionHomeRefusal(error)
      if (refusal !== undefined) return json({ ok: false, retryable: true, ...refusal }, 503)
      throw error
    }
  }
  const memberRef = formatScopeHandle(parseScopeRef(splitSessionRef(sessionRefValue).scopeRef))
  const identity = { sessionRef: sessionRefValue, hostSessionId, generation, memberRef }
  try {
    const projector = mobileTimelineProjector(deps, hrcClient)
    const cursor = url.searchParams.get('cursor')
    const page =
      cursor === null
        ? await projector.open(identity, { target: limit })
        : await projector.page(identity, cursor, { target: limit })
    const frames = page.atoms
      .map((atom) => atom.payload['frame'])
      .filter((frame): frame is MobileTimelineFrame => isRecord(frame))
      .map((frame, index) => ({ ...frame, frameSeq: index + 1 }))
    return json({
      projectionEpoch: page.projectionEpoch,
      atoms: page.atoms,
      olderCursor: page.olderCursor,
      hasMoreBefore: page.hasMoreBefore,
      snapshotHighWater: page.highWater,
      ...(page.resetReason !== undefined ? { resetReason: page.resetReason } : {}),
      // Transitional compatibility for T-07720: the new atom contract is
      // authoritative, while current clients can still paint the same frames.
      frames,
      oldestCursor: {
        hrcSeq: page.atoms.find((atom) => atom.sourceKind === 'hrc')?.sourceSeq ?? 0,
        messageSeq: page.atoms.find((atom) => atom.sourceKind === 'wrkq')?.sourceSeq ?? 0,
      },
      newestCursor: page.highWater,
    })
  } catch (error) {
    if (
      error instanceof MobileTimelineMalformedCursorError ||
      error instanceof MobileTimelineCursorInvalidError ||
      error instanceof MobileTimelineItemOversizeError ||
      error instanceof MobileTimelineSourcePositionExhaustedError
    ) {
      return json({ ok: false, code: error.code, message: error.message }, error.status)
    }
    throw error
  }
}
