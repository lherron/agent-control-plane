import type { UnifiedSessionEvent } from 'spaces-runtime'

export interface CompletedVisibleAssistantMessage {
  messageId?: string | undefined
  text: string
  outcome?:
    | { state: 'normal' }
    | { state: 'degraded'; reason: 'no_assistant_content'; source?: string | undefined }
    | undefined
}

export function toCompletedVisibleAssistantMessage(
  event: UnifiedSessionEvent
): CompletedVisibleAssistantMessage | undefined {
  if (event.type === 'turn_end') {
    const degraded = extractNoAssistantContentOutcome(event.payload)
    if (degraded !== undefined) {
      return { text: '', outcome: degraded }
    }

    const text = extractTurnEndAssistantText(event.payload)
    if (text === undefined || text.trim().length === 0) {
      return undefined
    }

    return { text }
  }

  if (event.type !== 'message_end') {
    return undefined
  }

  const message = event.message
  if (message === undefined || message.role !== 'assistant') {
    return undefined
  }

  const text = extractAssistantText(message.content)
  if (text.trim().length === 0) {
    return undefined
  }

  return {
    ...(event.messageId !== undefined ? { messageId: event.messageId } : {}),
    text,
  }
}

function extractNoAssistantContentOutcome(
  payload: unknown
): { state: 'degraded'; reason: 'no_assistant_content'; source?: string | undefined } | undefined {
  if (!isRecord(payload)) {
    return undefined
  }

  const source = payload['source']
  const finalOutput = payload['finalOutput']
  const content = payload['content']
  const hasFinalOutput =
    (typeof finalOutput === 'string' && finalOutput.trim().length > 0) ||
    (typeof content === 'string' && content.trim().length > 0)
  const message = isRecord(payload['message']) ? payload['message'] : undefined
  let hasAssistantMessage = false
  if (message?.['role'] === 'assistant') {
    const assistantText = tryExtractAssistantText(message['content'])
    if (assistantText === undefined) {
      return undefined
    }
    hasAssistantMessage = assistantText.trim().length > 0
  }

  if (hasFinalOutput || hasAssistantMessage) {
    return undefined
  }

  const outcome = payload['outcome']
  if (isRecord(outcome)) {
    const state = outcome['state']
    const reason = outcome['reason']
    if (state === 'degraded' && reason === 'no_assistant_content') {
      const source = typeof outcome['source'] === 'string' ? outcome['source'] : undefined
      return {
        state: 'degraded',
        reason: 'no_assistant_content',
        ...(source !== undefined ? { source } : {}),
      }
    }
  }

  if (isNoAssistantContentSource(source)) {
    return {
      state: 'degraded',
      reason: 'no_assistant_content',
      source,
    }
  }

  return undefined
}

function isNoAssistantContentSource(
  source: unknown
): source is 'launch_exit_synthesized' | 'codex_app_server' | 'codex_jsonl' {
  return (
    source === 'launch_exit_synthesized' ||
    source === 'codex_app_server' ||
    source === 'codex_jsonl'
  )
}

function extractTurnEndAssistantText(payload: unknown): string | undefined {
  if (!isRecord(payload)) {
    return undefined
  }

  const finalOutput = payload['finalOutput']
  if (typeof finalOutput === 'string' && finalOutput.trim().length > 0) {
    return finalOutput
  }

  const content = payload['content']
  if (typeof content === 'string' && content.trim().length > 0) {
    return content
  }

  const message = payload['message']
  if (!isRecord(message) || message['role'] !== 'assistant') {
    return undefined
  }

  return tryExtractAssistantText(message['content'])
}

function extractAssistantText(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }

  if (!Array.isArray(content)) {
    throw new Error('assistant message content must be a string or content block array')
  }

  const textParts: string[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) {
      throw new Error('assistant message content block must be an object')
    }

    const type = (block as { type?: unknown }).type
    if (type === 'text') {
      const text = (block as { text?: unknown }).text
      if (typeof text !== 'string') {
        throw new Error('assistant text block is missing text')
      }
      textParts.push(text)
    }
  }

  return textParts.join('')
}

function tryExtractAssistantText(content: unknown): string | undefined {
  try {
    return extractAssistantText(content)
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
