import { describe, expect, test } from 'bun:test'

import { type ConversationStore, createInMemoryConversationStore } from 'acp-conversation'

import type { AcpServerDeps } from '../src/index.js'

import { withWiredServer } from './fixtures/wired-server.js'

type LaunchCall = Parameters<NonNullable<AcpServerDeps['launchRoleScopedRun']>>[0]

type TurnInput = {
  threadId: string
  role: 'human' | 'assistant' | 'system'
  body: string
  renderState: 'pending' | 'streaming' | 'delivered' | 'failed' | 'redacted'
  links?: {
    inputAttemptId?: string | undefined
    runId?: string | undefined
    taskId?: string | undefined
    handoffId?: string | undefined
    deliveryRequestId?: string | undefined
    coordinationEventId?: string | undefined
  }
  actor?: { kind: 'human' | 'agent' | 'system'; id: string } | undefined
  sentAt: string
}

function createConversationStoreSpy(): {
  store: ConversationStore
  createTurnCalls: TurnInput[]
  close(): void
} {
  const baseStore = createInMemoryConversationStore()
  const createTurnCalls: TurnInput[] = []
  let threadOrdinal = 0

  const turnsById = new Map<string, TurnInput & { turnId: string }>()

  const store = Object.assign(baseStore, {
    createOrGetThread() {
      threadOrdinal += 1
      return { threadId: `thread_${threadOrdinal.toString().padStart(4, '0')}` }
    },
    createTurn(input: TurnInput) {
      createTurnCalls.push(structuredClone(input))
      const turnId = `turn_${createTurnCalls.length.toString().padStart(4, '0')}`
      turnsById.set(turnId, { turnId, ...structuredClone(input) })
      return turnId
    },
    attachLinks(turnId: string, links: TurnInput['links']) {
      const existing = turnsById.get(turnId)
      if (existing !== undefined) {
        existing.links = { ...(existing.links ?? {}), ...structuredClone(links) }
      }
      return (
        existing ?? {
          turnId,
          threadId: '',
          role: 'assistant' as const,
          body: '',
          renderState: 'pending' as const,
          sentAt: '',
        }
      )
    },
  }) as ConversationStore

  return {
    store,
    createTurnCalls,
    close() {
      baseStore.close()
    },
  }
}

function createLaunchOverrides(calls: LaunchCall[]): Partial<AcpServerDeps> {
  return {
    runtimeResolver: async () => ({
      agentRoot: '/tmp/agents/larry',
      projectRoot: '/tmp/project',
      cwd: '/tmp/project',
      runMode: 'task',
      bundle: { kind: 'agent-default' },
      harness: { provider: 'openai', interactive: true },
    }),
    launchRoleScopedRun: async (input) => {
      calls.push(input)
      await input.onEvent?.({
        type: 'message_end',
        messageId: 'assistant-visible',
        message: { role: 'assistant', content: 'Visible response' },
      })

      return {
        runId: input.acpRunId ?? 'launch-run-fallback',
        sessionId: 'session-launch-001',
      }
    },
  }
}

function findAssistantTurn(calls: readonly TurnInput[]): TurnInput | undefined {
  return calls.find((turn) => turn.role === 'assistant')
}

describe('actor-stamp: conversation turns', () => {
  test('prefers X-ACP-Actor over body actor when creating assistant turns', async () => {
    const conversation = createConversationStoreSpy()
    const launchCalls: LaunchCall[] = []

    try {
      await withWiredServer(
        async (fixture) => {
          fixture.interfaceStore.bindings.create({
            bindingId: 'ifb_123',
            gatewayId: 'discord_prod',
            conversationRef: 'channel:123',
            scopeRef: `agent:larry:project:${fixture.seed.projectId}`,
            laneRef: 'main',
            projectId: fixture.seed.projectId,
            status: 'active',
            createdAt: '2026-04-23T12:05:00.000Z',
            updatedAt: '2026-04-23T12:05:00.000Z',
          })

          const response = await fixture.request({
            method: 'POST',
            path: '/v1/interface/messages',
            headers: { 'x-acp-actor': 'agent:curly' },
            body: {
              actor: { kind: 'human', id: 'body-operator' },
              source: {
                gatewayId: 'discord_prod',
                conversationRef: 'channel:123',
                messageRef: 'discord:message:456',
                authorRef: 'discord:user:999',
              },
              content: 'Need an assistant reply.',
            },
          })

          expect(response.status).toBe(201)
          expect(findAssistantTurn(conversation.createTurnCalls)?.actor).toEqual({
            kind: 'agent',
            id: 'curly',
          })
        },
        {
          conversationStore: conversation.store,
          ...createLaunchOverrides(launchCalls),
        }
      )
    } finally {
      conversation.close()
    }
  })

  test('falls back to the body actor when creating assistant turns', async () => {
    const conversation = createConversationStoreSpy()
    const launchCalls: LaunchCall[] = []

    try {
      await withWiredServer(
        async (fixture) => {
          fixture.interfaceStore.bindings.create({
            bindingId: 'ifb_123',
            gatewayId: 'discord_prod',
            conversationRef: 'channel:123',
            scopeRef: `agent:larry:project:${fixture.seed.projectId}`,
            laneRef: 'main',
            projectId: fixture.seed.projectId,
            status: 'active',
            createdAt: '2026-04-23T12:05:00.000Z',
            updatedAt: '2026-04-23T12:05:00.000Z',
          })

          const response = await fixture.request({
            method: 'POST',
            path: '/v1/interface/messages',
            body: {
              actor: { kind: 'human', id: 'body-operator' },
              source: {
                gatewayId: 'discord_prod',
                conversationRef: 'channel:123',
                messageRef: 'discord:message:789',
                authorRef: 'discord:user:999',
              },
              content: 'Need a body-fallback assistant reply.',
            },
          })

          expect(response.status).toBe(201)
          expect(findAssistantTurn(conversation.createTurnCalls)?.actor).toEqual({
            kind: 'human',
            id: 'body-operator',
          })
        },
        {
          conversationStore: conversation.store,
          ...createLaunchOverrides(launchCalls),
        }
      )
    } finally {
      conversation.close()
    }
  })

  test('falls back to the default system actor when creating assistant turns without an actor', async () => {
    const conversation = createConversationStoreSpy()
    const launchCalls: LaunchCall[] = []

    try {
      await withWiredServer(
        async (fixture) => {
          fixture.interfaceStore.bindings.create({
            bindingId: 'ifb_123',
            gatewayId: 'discord_prod',
            conversationRef: 'channel:123',
            scopeRef: `agent:larry:project:${fixture.seed.projectId}`,
            laneRef: 'main',
            projectId: fixture.seed.projectId,
            status: 'active',
            createdAt: '2026-04-23T12:05:00.000Z',
            updatedAt: '2026-04-23T12:05:00.000Z',
          })

          const response = await fixture.request({
            method: 'POST',
            path: '/v1/interface/messages',
            body: {
              source: {
                gatewayId: 'discord_prod',
                conversationRef: 'channel:123',
                messageRef: 'discord:message:999',
                authorRef: 'discord:user:999',
              },
              content: 'Need a default-actor assistant reply.',
            },
          })

          expect(response.status).toBe(201)
          expect(findAssistantTurn(conversation.createTurnCalls)?.actor).toEqual({
            kind: 'system',
            id: 'acp-local',
          })
        },
        {
          conversationStore: conversation.store,
          ...createLaunchOverrides(launchCalls),
        }
      )
    } finally {
      conversation.close()
    }
  })
})
