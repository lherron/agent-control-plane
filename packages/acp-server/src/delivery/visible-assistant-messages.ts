import type { UnifiedSessionEvent } from 'spaces-runtime'

export interface CompletedVisibleAssistantMessage {
  messageId?: string | undefined
  text: string
}

export function toCompletedVisibleAssistantMessage(
  event: UnifiedSessionEvent
): CompletedVisibleAssistantMessage | undefined {
  if (event.type === 'turn_end') {
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

  return extractAssistantText(message['content'])
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
