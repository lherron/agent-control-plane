import { describe, expect, test } from 'bun:test'

import type { SessionRef } from 'agent-scope'

import { type ConversationStore, createInMemoryConversationStore } from '../index.js'

type ConversationAudience = 'human' | 'operator' | 'internal'

type ConversationThread = {
  threadId: string
  gatewayId: string
  conversationRef: string
  threadRef?: string | undefined
  createdAt: string
  sessionRef?: SessionRef | undefined
  title?: string | undefined
  audience: ConversationAudience
}

type ThreadStoreApi = {
  createOrGetThread(input: {
    gatewayId: string
    conversationRef: string
    threadRef?: string | undefined
    sessionRef?: SessionRef | undefined
    title?: string | undefined
    audience: ConversationAudience
  }): ConversationThread
  getThread(threadId: string): ConversationThread | undefined
  listThreads(filters?: {
    projectId?: string | undefined
    sessionRef?: SessionRef | undefined
  }): readonly ConversationThread[]
}

function requireThreadStoreApi(store: ConversationStore): ThreadStoreApi {
  const api = store as ConversationStore & Partial<ThreadStoreApi>

  expect(api.createOrGetThread).toEqual(expect.any(Function))
  expect(api.getThread).toEqual(expect.any(Function))
  expect(api.listThreads).toEqual(expect.any(Function))

  return api as ThreadStoreApi
}

describe('conversation thread store contract', () => {
  test('createOrGetThread is idempotent on gatewayId + conversationRef + threadRef', () => {
    const store = createInMemoryConversationStore()
    const api = requireThreadStoreApi(store)
    const sessionRef = {
      scopeRef: 'agent:smokey:project:agent-spaces:task:T-01176:role:tester',
      laneRef: 'main',
    } satisfies SessionRef

    const first = api.createOrGetThread({
      gatewayId: 'discord_prod',
      conversationRef: 'channel:123',
      threadRef: 'thread:abc',
      sessionRef,
      title: 'Red tests',
      audience: 'human',
    })
    const second = api.createOrGetThread({
      gatewayId: 'discord_prod',
      conversationRef: 'channel:123',
      threadRef: 'thread:abc',
      sessionRef,
      title: 'Ignored on read-after-create',
      audience: 'human',
    })
    const third = api.createOrGetThread({
      gatewayId: 'discord_prod',
      conversationRef: 'channel:123',
      threadRef: 'thread:def',
      audience: 'human',
    })

    expect(second.threadId).toBe(first.threadId)
    expect(second.createdAt).toBe(first.createdAt)
    expect(second.title).toBe('Red tests')
    expect(second.sessionRef).toEqual(sessionRef)
    expect(second.audience).toBe('human')
    expect(third.threadId).not.toBe(first.threadId)
    expect(api.getThread(first.threadId)).toEqual(first)
  })

  test('listThreads filters by parsed projectId and exact sessionRef linkage', () => {
    const store = createInMemoryConversationStore()
    const api = requireThreadStoreApi(store)
    const agentSpacesSession = {
      scopeRef: 'agent:smokey:project:agent-spaces:task:T-01176:role:tester',
      laneRef: 'main',
    } satisfies SessionRef
    const wrkqSession = {
      scopeRef: 'agent:clod:project:wrkq:task:T-09999:role:tester',
      laneRef: 'main',
    } satisfies SessionRef

    const first = api.createOrGetThread({
      gatewayId: 'discord_prod',
      conversationRef: 'channel:agent-spaces',
      sessionRef: agentSpacesSession,
      audience: 'human',
    })
    api.createOrGetThread({
      gatewayId: 'discord_prod',
      conversationRef: 'channel:wrkq',
      sessionRef: wrkqSession,
      audience: 'operator',
    })
    api.createOrGetThread({
      gatewayId: 'discord_prod',
      conversationRef: 'channel:internal',
      audience: 'internal',
    })

    expect(api.listThreads({ projectId: 'agent-spaces' })).toEqual([first])
    expect(api.listThreads({ sessionRef: agentSpacesSession })).toEqual([first])
    expect(api.listThreads({ projectId: 'missing-project' })).toEqual([])
  })

  test('projectId filter matches base project scopes as well as deeper scopes', () => {
    const store = createInMemoryConversationStore()
    const api = requireThreadStoreApi(store)

    // Base scope — no segments after :project:<id>
    const baseSession = {
      scopeRef: 'agent:curly:project:agent-spaces',
      laneRef: 'main',
    } satisfies SessionRef
    const baseThread = api.createOrGetThread({
      gatewayId: 'gw',
      conversationRef: 'conv:base',
      sessionRef: baseSession,
      audience: 'operator',
    })

    // Deeper scope — has task segment after project
    const deepSession = {
      scopeRef: 'agent:curly:project:agent-spaces:task:T-01194',
      laneRef: 'main',
    } satisfies SessionRef
    const deepThread = api.createOrGetThread({
      gatewayId: 'gw',
      conversationRef: 'conv:deep',
      sessionRef: deepSession,
      audience: 'operator',
    })

    // Different project — should not match
    const otherSession = {
      scopeRef: 'agent:curly:project:other-project',
      laneRef: 'main',
    } satisfies SessionRef
    api.createOrGetThread({
      gatewayId: 'gw',
      conversationRef: 'conv:other',
      sessionRef: otherSession,
      audience: 'operator',
    })

    const results = api.listThreads({ projectId: 'agent-spaces' })
    expect(results).toHaveLength(2)
    expect(results.map((t) => t.threadId)).toContain(baseThread.threadId)
    expect(results.map((t) => t.threadId)).toContain(deepThread.threadId)

    // Negative case — other-project threads not returned
    const otherResults = api.listThreads({ projectId: 'other-project' })
    expect(otherResults).toHaveLength(1)
    expect(otherResults[0]?.sessionRef?.scopeRef).toBe('agent:curly:project:other-project')

    // Non-existent project returns empty
    expect(api.listThreads({ projectId: 'agent-spaces-extended' })).toEqual([])
  })
})
