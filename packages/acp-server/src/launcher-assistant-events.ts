import type { HrcEventEnvelope } from 'hrc-core'
import type { UnifiedSessionEvent } from 'spaces-runtime'
import { readRecord, readOptionalString as readString } from './wrkf/value.js'

export type RawRunEventRecord = Pick<HrcEventEnvelope, 'eventKind' | 'eventJson'>

export function toUnifiedAssistantMessageEndFromRawEvents(
  events: readonly RawRunEventRecord[]
): UnifiedSessionEvent | undefined {
  let explicitMessageEnd: UnifiedSessionEvent | undefined
  let assistantMessage: UnifiedSessionEvent | undefined
  let finalOutput: UnifiedSessionEvent | undefined
  let accumulatedDelta = ''

  for (const event of events) {
    const eventJson = readRecord(event.eventJson) ?? {}
    const type = readString(eventJson, 'type')
    if (type === 'message_end') {
      const candidate = readAssistantMessageEndEvent(eventJson)
      if (candidate !== undefined) {
        explicitMessageEnd = candidate
      }
      continue
    }

    if (type === 'message' && readString(eventJson, 'role') === 'assistant') {
      const text = extractAssistantText(eventJson['content'])
      if (text !== undefined && text.trim().length > 0) {
        const messageId = readAssistantMessageId(eventJson)
        assistantMessage = {
          type: 'message_end',
          ...(messageId !== undefined ? { messageId } : {}),
          message: { role: 'assistant', content: [{ type: 'text', text }] },
        }
      }
      continue
    }

    if (type === 'message_delta' && readString(eventJson, 'role') === 'assistant') {
      const delta = readString(eventJson, 'delta')
      if (delta !== undefined) {
        accumulatedDelta += delta
      }
      continue
    }

    if (type === 'complete') {
      const result = readRecord(eventJson['result']) ?? {}
      const output = readString(result, 'finalOutput')
      if (output !== undefined && output.trim().length > 0) {
        finalOutput = {
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: output }],
          },
        }
      }
    }
  }

  if (explicitMessageEnd !== undefined) {
    return explicitMessageEnd
  }
  if (assistantMessage !== undefined) {
    return assistantMessage
  }
  if (finalOutput !== undefined) {
    return finalOutput
  }
  if (accumulatedDelta.trim().length > 0) {
    return {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: accumulatedDelta }],
      },
    }
  }
  return undefined
}

export function assistantMessagePayloadToUnifiedEvent(
  payload: unknown
): UnifiedSessionEvent | undefined {
  const record = readRecord(payload) ?? {}
  if (readString(record, 'type') !== 'message_end') {
    return undefined
  }

  const message = readRecord(record['message']) ?? {}
  if (readString(message, 'role') !== 'assistant') {
    return undefined
  }

  const text = extractAssistantText(message['content'])
  if (text === undefined || text.trim().length === 0) {
    return undefined
  }

  return {
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
    },
  }
}

export function assistantCompletionPayloadToUnifiedEvent(
  payload: unknown
): UnifiedSessionEvent | undefined {
  const record = readRecord(payload) ?? {}

  const fromMessage = assistantMessagePayloadToUnifiedEvent({
    type: 'message_end',
    message: record['message'],
  })
  if (fromMessage !== undefined) {
    return fromMessage
  }

  const finalOutput = readString(record, 'finalOutput') ?? readString(record, 'content')
  if (finalOutput === undefined || finalOutput.trim().length === 0) {
    const source = readString(record, 'source')
    const outcome = readRecord(record['outcome']) ?? {}
    if (
      (readString(outcome, 'state') === 'degraded' &&
        readString(outcome, 'reason') === 'no_assistant_content') ||
      source === 'launch_exit_synthesized' ||
      source === 'codex_app_server' ||
      source === 'codex_jsonl'
    ) {
      return {
        type: 'turn_end',
        payload,
      }
    }
    return undefined
  }

  return {
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: finalOutput }],
    },
  }
}

function readAssistantMessageEndEvent(
  eventJson: Record<string, unknown>
): UnifiedSessionEvent | undefined {
  const message = readRecord(eventJson['message']) ?? {}
  if (readString(message, 'role') !== 'assistant') {
    return undefined
  }

  const text = extractAssistantText(message['content'])
  if (text === undefined || text.trim().length === 0) {
    return undefined
  }

  const messageId = readString(eventJson, 'messageId')

  return {
    type: 'message_end',
    ...(messageId !== undefined ? { messageId } : {}),
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
    },
  }
}

function readAssistantMessageId(eventJson: Record<string, unknown>): string | undefined {
  const payload = readRecord(eventJson['payload']) ?? {}
  const message = readRecord(payload['message']) ?? {}
  return readString(message, 'id')
}

function extractAssistantText(content: unknown): string | undefined {
  if (typeof content === 'string') {
    return content
  }

  if (!Array.isArray(content)) {
    return undefined
  }

  const textParts: string[] = []
  for (const block of content) {
    const record = readRecord(block) ?? {}
    if (readString(record, 'type') !== 'text') {
      continue
    }
    const text = readString(record, 'text')
    if (text !== undefined) {
      textParts.push(text)
    }
  }

  return textParts.length > 0 ? textParts.join('') : undefined
}
