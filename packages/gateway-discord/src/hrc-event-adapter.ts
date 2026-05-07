import { admissionLabel } from 'acp-ops-projection'
import type { Message, ToolResult } from 'spaces-runtime'
import { createLogger } from './logger.js'
import type { GatewaySessionEvent, SessionEventEnvelope } from './types.js'

const log = createLogger({ component: 'gateway-discord' })

export type HrcLifecycleEventPayload = {
  hrcSeq: number
  eventKind: string
  scopeRef: string
  runId?: string | undefined
  payload: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function getString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

function getBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key]
  return typeof value === 'boolean' ? value : undefined
}

function deriveProjectId(scopeRef: string): string | undefined {
  const parts = scopeRef.split(':')
  const projectIndex = parts.indexOf('project')
  if (projectIndex < 0) {
    return undefined
  }

  const projectId = parts[projectIndex + 1]
  return projectId && projectId.length > 0 ? projectId : undefined
}

function textFrom(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }

  if (value === undefined || value === null) {
    return ''
  }

  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function isNoticePayload(payload: unknown): payload is {
  type: 'notice'
  level: 'info' | 'warn' | 'error'
  message: string
} {
  if (!isRecord(payload) || payload['type'] !== 'notice') {
    return false
  }

  return (
    (payload['level'] === 'info' || payload['level'] === 'warn' || payload['level'] === 'error') &&
    typeof payload['message'] === 'string'
  )
}

function adaptToolCall(payload: unknown): GatewaySessionEvent | undefined {
  if (!isRecord(payload)) {
    return undefined
  }

  const toolUseId = getString(payload, 'toolUseId')
  const toolName = getString(payload, 'toolName')
  if (!toolUseId || !toolName) {
    return undefined
  }

  const input = payload['input']
  return {
    type: 'tool_execution_start',
    toolUseId,
    toolName,
    input: isRecord(input) ? input : {},
  }
}

function adaptToolResult(payload: unknown): GatewaySessionEvent | undefined {
  if (!isRecord(payload)) {
    return undefined
  }

  const toolUseId = getString(payload, 'toolUseId')
  const toolName = getString(payload, 'toolName')
  if (!toolUseId || !toolName) {
    return undefined
  }

  const result = payload['result']
  const isError = getBoolean(payload, 'isError')
  return {
    type: 'tool_execution_end',
    toolUseId,
    toolName,
    result: isRecord(result)
      ? (result as unknown as ToolResult)
      : {
          content: [{ type: 'text', text: textFrom(result) }],
        },
    ...(isError !== undefined ? { isError } : {}),
  }
}

function adaptAssistantMessage(payload: unknown): GatewaySessionEvent | undefined {
  if (!isRecord(payload)) {
    return undefined
  }

  const message = isRecord(payload['message']) ? payload['message'] : payload
  if (message['role'] !== 'assistant') {
    return undefined
  }

  const content = message['content']
  if (typeof content !== 'string' && !Array.isArray(content)) {
    return undefined
  }

  return {
    type: 'message_end',
    message: {
      role: 'assistant',
      content: content as Message['content'],
    },
    ...(getBoolean(payload, 'truncated') === true ? { truncated: true } : {}),
  }
}

function adaptTurnCompleted(payload: unknown): GatewaySessionEvent {
  return {
    type: 'turn_end',
    payload,
  }
}

export function adaptHrcLifecycleEvent(
  event: HrcLifecycleEventPayload
): SessionEventEnvelope | undefined {
  const projectId = deriveProjectId(event.scopeRef)
  const runId = event.runId?.trim()
  let sessionEvent: GatewaySessionEvent | undefined

  if (!runId) {
    log.debug('adapter.event.dropped', { data: { eventKind: event.eventKind } })
    return undefined
  }

  if (projectId === undefined) {
    log.debug('adapter.event.dropped', { data: { eventKind: event.eventKind, runId } })
    return undefined
  }

  if (isNoticePayload(event.payload)) {
    sessionEvent = {
      type: 'notice',
      level: event.payload.level,
      message: event.payload.message,
    }
  } else {
    switch (event.eventKind) {
      case 'turn.tool_call':
      case 'tool_execution_start':
        sessionEvent = adaptToolCall(event.payload)
        break
      case 'turn.tool_result':
      case 'tool_execution_end':
        sessionEvent = adaptToolResult(event.payload)
        break
      case 'turn.message':
      case 'message_end':
        sessionEvent = adaptAssistantMessage(event.payload)
        break
      case 'turn.completed':
      case 'turn_end':
        sessionEvent = adaptTurnCompleted(event.payload)
        break
      default:
        if (event.eventKind.startsWith('input.')) {
          const pr = isRecord(event.payload) ? event.payload : {}
          sessionEvent = {
            type: 'notice',
            level: 'info',
            message: admissionLabel({
              eventKind: event.eventKind,
              admissionKind: getString(pr, 'admissionKind'),
              applicationStatus: getString(pr, 'applicationStatus'),
              reason: getString(pr, 'reason'),
            }),
          }
        }
        break
    }
  }

  if (!sessionEvent) {
    log.debug('adapter.event.dropped', { data: { eventKind: event.eventKind, runId } })
    return undefined
  }

  return {
    projectId,
    runId,
    seq: event.hrcSeq,
    event: sessionEvent,
  }
}

export const hrcLifecycleEventToSessionEnvelope = adaptHrcLifecycleEvent
