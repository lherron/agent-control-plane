import type { Actor } from '../models/actor.js'

export const conversationTurnRenderStates = [
  'pending',
  'streaming',
  'delivered',
  'failed',
  'redacted',
] as const

export type ConversationTurnRenderState = (typeof conversationTurnRenderStates)[number]

export interface ConversationTurn {
  turnId: string
  conversationThreadId: string
  author: Actor
  direction: 'inbound' | 'outbound' | 'local'
  audience: 'human' | 'operator' | 'mixed'
  renderState: ConversationTurnRenderState
  createdAt: string
  content?: string | undefined
}
