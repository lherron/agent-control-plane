import { createInMemoryConversationStore } from 'acp-conversation'

import type { AcpServerDeps } from '../src/index.js'

import { type WiredServerFixture, withWiredServer } from './fixtures/wired-server.js'

type ConversationThread = {
  threadId: string
  gatewayId: string
  conversationRef: string
  threadRef?: string | undefined
  sessionRef?: { scopeRef: string; laneRef: string } | undefined
  audience: string
}

type ConversationTurn = {
  threadId: string
  role: string
  body: string
  renderState: string
  links?: Record<string, string | undefined> | undefined
  actor?: { kind: string; id: string } | undefined
  sentAt: string
}

function createLaunchOverrides(): Partial<AcpServerDeps> {
  return {
    runtimeResolver: async () => ({
      agentRoot: '/tmp/agents/curly',
      projectRoot: '/tmp/project',
      cwd: '/tmp/project',
      runMode: 'task',
      bundle: { kind: 'compose', compose: [] },
      harness: { provider: 'openai', interactive: true },
    }),
    launchRoleScopedRun: async (input) => {
      await input.onEvent?.({
        type: 'message_end',
        messageId: 'assistant-1',
        message: { role: 'assistant', content: 'Visible response' },
      })

      return { runId: 'launch-run-002', sessionId: 'session-002' }
    },
  }
}

async function readOnlyThread(
  fixture: WiredServerFixture
): Promise<{ thread: ConversationThread; turns: ConversationTurn[] }> {
  const threadsResponse = await fixture.request({
    method: 'GET',
    path: '/v1/conversation/threads',
  })
  expect(threadsResponse.status).toBe(200)
  const { threads } = await fixture.json<{ threads: ConversationThread[] }>(threadsResponse)
  expect(threads).toHaveLength(1)
  const thread = threads[0] as ConversationThread

  const turnsResponse = await fixture.request({
    method: 'GET',
    path: `/v1/conversation/threads/${thread.threadId}/turns`,
  })
  expect(turnsResponse.status).toBe(200)
  const { turns } = await fixture.json<{ turns: ConversationTurn[] }>(turnsResponse)
  return { thread, turns }
}

describe('conversation write-points', () => {
  test('POST /v1/interface/messages creates a delivered human turn on the matching thread', async () => {
    const conversationStore = createInMemoryConversationStore()

    try {
      await withWiredServer(
        async (fixture) => {
          fixture.interfaceStore.bindings.create({
            bindingId: 'ifb_123',
            gatewayId: 'discord_prod',
            conversationRef: 'channel:123',
            threadRef: 'thread:abc',
            scopeRef: `agent:curly:project:${fixture.seed.projectId}`,
            laneRef: 'main',
            projectId: fixture.seed.projectId,
            status: 'active',
            createdAt: '2026-04-23T12:00:00.000Z',
            updatedAt: '2026-04-23T12:00:00.000Z',
          })

          const response = await fixture.request({
            method: 'POST',
            path: '/v1/interface/messages',
            body: {
              source: {
                gatewayId: 'discord_prod',
                conversationRef: 'channel:123',
                threadRef: 'thread:abc',
                messageRef: 'discord:message:123',
                authorRef: 'discord:user:999',
              },
              content: 'Please summarize the status.',
            },
          })
          const payload = await fixture.json<{ inputAttemptId: string }>(response)

          expect(response.status).toBe(201)
          const { thread, turns } = await readOnlyThread(fixture)
          expect(thread).toMatchObject({
            gatewayId: 'discord_prod',
            conversationRef: 'channel:123',
            threadRef: 'thread:abc',
            sessionRef: {
              scopeRef: `agent:curly:project:${fixture.seed.projectId}`,
              laneRef: 'main',
            },
            audience: 'human',
          })
          expect(turns).toEqual([
            expect.objectContaining({
              threadId: thread.threadId,
              role: 'human',
              body: 'Please summarize the status.',
              renderState: 'delivered',
              links: { inputAttemptId: payload.inputAttemptId },
              actor: { kind: 'human', id: 'discord:user:999' },
              sentAt: expect.any(String),
            }),
          ])
        },
        { conversationStore }
      )
    } finally {
      conversationStore.close()
    }
  })

  test('completed gateway-targeted runs create a pending assistant turn linked to the ACP run', async () => {
    const conversationStore = createInMemoryConversationStore()

    try {
      await withWiredServer(
        async (fixture) => {
          fixture.interfaceStore.bindings.create({
            bindingId: 'ifb_123',
            gatewayId: 'discord_prod',
            conversationRef: 'channel:123',
            scopeRef: `agent:curly:project:${fixture.seed.projectId}`,
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
                messageRef: 'discord:message:456',
                authorRef: 'discord:user:999',
              },
              content: 'Need an assistant reply.',
            },
          })
          const payload = await fixture.json<{ runId: string }>(response)

          expect(response.status).toBe(201)
          const { thread, turns } = await readOnlyThread(fixture)
          const assistant = turns.filter((turn) => turn.role === 'assistant')
          expect(assistant).toEqual([
            expect.objectContaining({
              threadId: thread.threadId,
              body: 'Visible response',
              renderState: 'pending',
              links: expect.objectContaining({ runId: payload.runId }),
              actor: { kind: 'system', id: 'acp-local' },
              sentAt: expect.any(String),
            }),
          ])
        },
        { conversationStore, ...createLaunchOverrides() }
      )
    } finally {
      conversationStore.close()
    }
  })
})
