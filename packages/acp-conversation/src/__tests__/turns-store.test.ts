import { describe, expect, test } from 'bun:test'

import type { Actor, ConversationTurnRenderState } from 'acp-core'

import { type ConversationStore, createInMemoryConversationStore } from '../index.js'

type TurnRole = 'human' | 'assistant' | 'system'

type ConversationTurnLinks = {
  inputAttemptId?: string | undefined
  runId?: string | undefined
  taskId?: string | undefined
  handoffId?: string | undefined
  deliveryRequestId?: string | undefined
  coordinationEventId?: string | undefined
}

type StoredConversationTurn = {
  turnId: string
  threadId: string
  role: TurnRole
  body: string
  renderState: ConversationTurnRenderState
  links?: ConversationTurnLinks | undefined
  actor?: Actor | undefined
  sentAt: string
  failureReason?: string | undefined
}

type TurnStoreApi = {
  createTurn(input: {
    threadId: string
    role: TurnRole
    body: string
    renderState: ConversationTurnRenderState
    links?: ConversationTurnLinks | undefined
    actor?: Actor | undefined
    sentAt: string
  }): string
  updateRenderState(turnId: string, nextState: ConversationTurnRenderState): StoredConversationTurn
  listTurns(
    threadId: string,
    options?: { since?: string | undefined; limit?: number | undefined }
  ): readonly StoredConversationTurn[]
  attachLinks(turnId: string, links: ConversationTurnLinks): StoredConversationTurn
}

function requireTurnStoreApi(store: ConversationStore): TurnStoreApi {
  const api = store as ConversationStore & Partial<TurnStoreApi>

  expect(api.createTurn).toEqual(expect.any(Function))
  expect(api.updateRenderState).toEqual(expect.any(Function))
  expect(api.listTurns).toEqual(expect.any(Function))
  expect(api.attachLinks).toEqual(expect.any(Function))

  return api as TurnStoreApi
}

describe('conversation turn store contract', () => {
  test('creates turns in sentAt order and supports attaching links after creation', () => {
    const store = createInMemoryConversationStore()
    const api = requireTurnStoreApi(store)

    const firstTurnId = api.createTurn({
      threadId: 'thread_123',
      role: 'assistant',
      body: 'Second chronologically',
      renderState: 'pending',
      sentAt: '2026-04-23T12:00:02.000Z',
    })
    const secondTurnId = api.createTurn({
      threadId: 'thread_123',
      role: 'human',
      body: 'First chronologically',
      renderState: 'delivered',
      actor: { kind: 'human', id: 'discord:user:123' },
      sentAt: '2026-04-23T12:00:01.000Z',
    })

    const patched = api.attachLinks(firstTurnId, {
      runId: 'run_123',
      deliveryRequestId: 'dr_123',
    })
    const listed = api.listTurns('thread_123')

    expect(patched.links).toEqual({ runId: 'run_123', deliveryRequestId: 'dr_123' })
    expect(listed.map((turn) => turn.turnId)).toEqual([secondTurnId, firstTurnId])
    expect(api.listTurns('thread_123', { since: '2026-04-23T12:00:01.500Z' })).toEqual([
      expect.objectContaining({ turnId: firstTurnId }),
    ])
    expect(api.listTurns('thread_123', { limit: 1 })).toEqual([
      expect.objectContaining({ turnId: secondTurnId }),
    ])
  })

  test('allows only forward render-state transitions plus universal redaction', () => {
    const store = createInMemoryConversationStore()
    const api = requireTurnStoreApi(store)

    const streamingTurnId = api.createTurn({
      threadId: 'thread_123',
      role: 'assistant',
      body: 'streaming body',
      renderState: 'pending',
      sentAt: '2026-04-23T12:10:00.000Z',
    })
    const failedTurnId = api.createTurn({
      threadId: 'thread_123',
      role: 'assistant',
      body: 'failing body',
      renderState: 'pending',
      sentAt: '2026-04-23T12:11:00.000Z',
    })

    expect(api.updateRenderState(streamingTurnId, 'streaming')).toMatchObject({
      turnId: streamingTurnId,
      renderState: 'streaming',
    })
    expect(api.updateRenderState(streamingTurnId, 'delivered')).toMatchObject({
      turnId: streamingTurnId,
      renderState: 'delivered',
    })
    expect(api.updateRenderState(failedTurnId, 'failed')).toMatchObject({
      turnId: failedTurnId,
      renderState: 'failed',
    })

    const redactedTurnId = api.createTurn({
      threadId: 'thread_123',
      role: 'system',
      body: 'moderation removed this',
      renderState: 'delivered',
      sentAt: '2026-04-23T12:12:00.000Z',
    })
    expect(api.updateRenderState(redactedTurnId, 'redacted')).toMatchObject({
      turnId: redactedTurnId,
      renderState: 'redacted',
    })

    expect(() => api.updateRenderState(streamingTurnId, 'pending')).toThrow(
      /invalid render state transition/i
    )
    expect(() => api.updateRenderState(failedTurnId, 'delivered')).toThrow(
      /invalid render state transition/i
    )
  })
})
