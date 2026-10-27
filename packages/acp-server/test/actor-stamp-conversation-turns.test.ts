import { describe, expect, test } from 'bun:test'

import { createInMemoryConversationStore } from 'acp-conversation'

import type { AcpServerDeps } from '../src/index.js'

import { type WiredServerFixture, withWiredServer } from './fixtures/wired-server.js'

type ConversationTurn = {
  role: string
  actor?: { kind: string; id: string } | undefined
}

const ACTOR_ROWS = [
  {
    name: 'header beats body',
    headers: { 'x-acp-actor': 'agent:curly' },
    bodyActor: { kind: 'human', id: 'body-operator' },
    expected: { kind: 'agent', id: 'curly' },
  },
  {
    name: 'body without header',
    headers: undefined,
    bodyActor: { kind: 'human', id: 'body-operator' },
    expected: { kind: 'human', id: 'body-operator' },
  },
  {
    name: 'neither falls back to the default system actor',
    headers: undefined,
    bodyActor: undefined,
    expected: { kind: 'system', id: 'acp-local' },
  },
] as const

function createLaunchOverrides(): Partial<AcpServerDeps> {
  return {
    runtimeResolver: async () => ({
      agentRoot: '/tmp/agents/larry',
      projectRoot: '/tmp/project',
      cwd: '/tmp/project',
      runMode: 'task',
      bundle: { kind: 'compose', compose: [] },
      harness: { provider: 'openai', interactive: true },
    }),
    launchRoleScopedRun: async (input) => {
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

async function readAssistantTurn(fixture: WiredServerFixture): Promise<ConversationTurn> {
  const threadsResponse = await fixture.request({
    method: 'GET',
    path: '/v1/conversation/threads',
  })
  expect(threadsResponse.status).toBe(200)
  const { threads } = await fixture.json<{ threads: Array<{ threadId: string }> }>(threadsResponse)
  expect(threads).toHaveLength(1)

  const turnsResponse = await fixture.request({
    method: 'GET',
    path: `/v1/conversation/threads/${threads[0]?.threadId}/turns`,
  })
  expect(turnsResponse.status).toBe(200)
  const { turns } = await fixture.json<{ turns: ConversationTurn[] }>(turnsResponse)
  const assistant = turns.filter((turn) => turn.role === 'assistant')
  expect(assistant).toHaveLength(1)
  return assistant[0] as ConversationTurn
}

describe('actor-stamp: conversation turns', () => {
  test('prefers X-ACP-Actor over body actor when creating assistant turns', async () => {
    for (const row of ACTOR_ROWS) {
      const conversationStore = createInMemoryConversationStore()

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
              headers: row.headers,
              body: {
                ...(row.bodyActor !== undefined ? { actor: row.bodyActor } : {}),
                source: {
                  gatewayId: 'discord_prod',
                  conversationRef: 'channel:123',
                  messageRef: 'discord:message:456',
                  authorRef: 'discord:user:999',
                },
                content: `Need an assistant reply (${row.name}).`,
              },
            })

            expect(response.status, row.name).toBe(201)
            expect((await readAssistantTurn(fixture)).actor, row.name).toEqual(row.expected)
          },
          {
            conversationStore,
            ...createLaunchOverrides(),
          }
        )
      } finally {
        conversationStore.close()
      }
    }
  })
})
