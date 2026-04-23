import { type ConversationStore, createInMemoryConversationStore } from 'acp-conversation'

import { withWiredServer } from './fixtures/wired-server.js'

type ConversationAudience = 'human' | 'operator' | 'internal'
type TurnRole = 'human' | 'assistant' | 'system'
type RenderState = 'pending' | 'streaming' | 'delivered' | 'failed' | 'redacted'

type ConversationLinks = {
  inputAttemptId?: string | undefined
  runId?: string | undefined
  taskId?: string | undefined
  handoffId?: string | undefined
  deliveryRequestId?: string | undefined
  coordinationEventId?: string | undefined
}

type ThreadInput = {
  gatewayId: string
  conversationRef: string
  threadRef?: string | undefined
  sessionRef?: { scopeRef: string; laneRef: string } | undefined
  title?: string | undefined
  audience: ConversationAudience
}

type TurnInput = {
  threadId: string
  role: TurnRole
  body: string
  renderState: RenderState
  links?: ConversationLinks | undefined
  actor?: { kind: 'human' | 'agent' | 'system'; id: string } | undefined
  sentAt: string
}

type SpyTurn = TurnInput & {
  turnId: string
}

type ConversationWriteApi = {
  createOrGetThread(input: ThreadInput): { threadId: string }
  getThread(threadId: string): { threadId: string } | undefined
  listThreads(): readonly { threadId: string }[]
  createTurn(input: TurnInput): string
  updateRenderState(turnId: string, nextState: RenderState): SpyTurn
  attachLinks(turnId: string, links: ConversationLinks): SpyTurn
}

function createConversationStoreSpy(): {
  store: ConversationStore
  createThreadCalls: ThreadInput[]
  createTurnCalls: TurnInput[]
  updateRenderStateCalls: Array<{ turnId: string; nextState: RenderState }>
  attachLinksCalls: Array<{ turnId: string; links: ConversationLinks }>
  seedTurn(turn: SpyTurn): void
  close(): void
} {
  const baseStore = createInMemoryConversationStore()
  const createThreadCalls: ThreadInput[] = []
  const createTurnCalls: TurnInput[] = []
  const updateRenderStateCalls: Array<{ turnId: string; nextState: RenderState }> = []
  const attachLinksCalls: Array<{ turnId: string; links: ConversationLinks }> = []
  const turnsById = new Map<string, SpyTurn>()

  let threadOrdinal = 0
  let turnOrdinal = 0

  const api: ConversationWriteApi = {
    createOrGetThread(input) {
      createThreadCalls.push(structuredClone(input))
      threadOrdinal += 1
      return { threadId: `thread_${threadOrdinal.toString().padStart(4, '0')}` }
    },
    getThread(threadId) {
      return { threadId }
    },
    listThreads() {
      return []
    },
    createTurn(input) {
      createTurnCalls.push(structuredClone(input))
      turnOrdinal += 1
      const turnId = `turn_${turnOrdinal.toString().padStart(4, '0')}`
      turnsById.set(turnId, { turnId, ...structuredClone(input) })
      return turnId
    },
    updateRenderState(turnId, nextState) {
      updateRenderStateCalls.push({ turnId, nextState })
      const existing = turnsById.get(turnId)
      return {
        turnId,
        threadId: existing?.threadId ?? 'thread_missing',
        role: existing?.role ?? 'assistant',
        body: existing?.body ?? '',
        renderState: nextState,
        links: existing?.links,
        actor: existing?.actor,
        sentAt: existing?.sentAt ?? '2026-04-23T00:00:00.000Z',
      }
    },
    attachLinks(turnId, links) {
      attachLinksCalls.push({ turnId, links: structuredClone(links) })
      const existing = turnsById.get(turnId)
      const next: SpyTurn = {
        turnId,
        threadId: existing?.threadId ?? 'thread_missing',
        role: existing?.role ?? 'assistant',
        body: existing?.body ?? '',
        renderState: existing?.renderState ?? 'pending',
        links: { ...(existing?.links ?? {}), ...structuredClone(links) },
        actor: existing?.actor,
        sentAt: existing?.sentAt ?? '2026-04-23T00:00:00.000Z',
      }
      turnsById.set(turnId, next)
      return next
    },
  }

  const store = Object.assign(baseStore, api) as ConversationStore

  return {
    store,
    createThreadCalls,
    createTurnCalls,
    updateRenderStateCalls,
    attachLinksCalls,
    seedTurn(turn) {
      turnsById.set(turn.turnId, structuredClone(turn))
      // Also index in SQLite so findTurnByLink can discover seeded turns
      try {
        baseStore.sqlite
          .prepare(
            `INSERT OR REPLACE INTO conversation_turns
              (turnId, threadId, role, body, renderState, actorKind, actorId, sentAt,
               linksInputAttemptId, linksRunId, linksTaskId, linksHandoffId,
               linksDeliveryRequestId, linksCoordinationEventId, failureReason)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            turn.turnId,
            turn.threadId,
            turn.role,
            turn.body,
            turn.renderState,
            turn.actor?.kind ?? null,
            turn.actor?.id ?? null,
            turn.sentAt,
            turn.links?.inputAttemptId ?? null,
            turn.links?.runId ?? null,
            turn.links?.taskId ?? null,
            turn.links?.handoffId ?? null,
            turn.links?.deliveryRequestId ?? null,
            turn.links?.coordinationEventId ?? null,
            null
          )
      } catch {
        // Ignore if SQLite table not ready
      }
    },
    close() {
      baseStore.close()
    },
  }
}

describe('conversation write-points', () => {
  test('POST /v1/interface/messages creates a delivered human turn on the matching thread', async () => {
    const conversation = createConversationStoreSpy()

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
          expect(conversation.createThreadCalls).toEqual([
            {
              gatewayId: 'discord_prod',
              conversationRef: 'channel:123',
              threadRef: 'thread:abc',
              sessionRef: {
                scopeRef: `agent:curly:project:${fixture.seed.projectId}`,
                laneRef: 'main',
              },
              audience: 'human',
            },
          ])
          expect(conversation.createTurnCalls).toEqual([
            {
              threadId: 'thread_0001',
              role: 'human',
              body: 'Please summarize the status.',
              renderState: 'delivered',
              links: { inputAttemptId: payload.inputAttemptId },
              actor: { kind: 'human', id: 'discord:user:999' },
              sentAt: expect.any(String),
            },
          ])
        },
        { conversationStore: conversation.store }
      )
    } finally {
      conversation.close()
    }
  })

  test('completed gateway-targeted runs create a pending assistant turn linked to the ACP run', async () => {
    const conversation = createConversationStoreSpy()

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
          expect(conversation.createTurnCalls).toEqual(
            expect.arrayContaining([
              {
                threadId: 'thread_0001',
                role: 'assistant',
                body: 'Visible response',
                renderState: 'pending',
                links: { runId: payload.runId },
                actor: { kind: 'system', id: 'acp-local' },
                sentAt: expect.any(String),
              },
            ])
          )
        },
        {
          conversationStore: conversation.store,
          runtimeResolver: async () => ({
            agentRoot: '/tmp/agents/curly',
            projectRoot: '/tmp/project',
            cwd: '/tmp/project',
            runMode: 'task',
            bundle: { kind: 'agent-default' },
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
      )
    } finally {
      conversation.close()
    }
  })

  test('gateway delivery ack advances the linked assistant turn to delivered', async () => {
    const conversation = createConversationStoreSpy()

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
            createdAt: '2026-04-23T12:10:00.000Z',
            updatedAt: '2026-04-23T12:10:00.000Z',
          })

          const response = await fixture.request({
            method: 'POST',
            path: '/v1/interface/messages',
            body: {
              source: {
                gatewayId: 'discord_prod',
                conversationRef: 'channel:123',
                messageRef: 'discord:message:789',
                authorRef: 'discord:user:999',
              },
              content: 'Reply please.',
            },
          })
          const payload = await fixture.json<{ runId: string }>(response)
          const [delivery] = fixture.interfaceStore.deliveries.listQueuedForGateway('discord_prod')

          expect(response.status).toBe(201)
          expect(delivery).toBeDefined()

          conversation.seedTurn({
            turnId: 'turn_assistant',
            threadId: 'thread_0001',
            role: 'assistant',
            body: 'Visible response',
            renderState: 'pending',
            links: {
              runId: payload.runId,
              deliveryRequestId: delivery?.deliveryRequestId,
            },
            actor: { kind: 'agent', id: 'curly' },
            sentAt: '2026-04-23T12:10:05.000Z',
          })

          const ackResponse = await fixture.request({
            method: 'POST',
            path: `/v1/gateway/deliveries/${delivery?.deliveryRequestId}/ack`,
          })

          expect(ackResponse.status).toBe(200)
          expect(conversation.updateRenderStateCalls).toEqual([
            { turnId: 'turn_assistant', nextState: 'delivered' },
          ])
        },
        {
          conversationStore: conversation.store,
          runtimeResolver: async () => ({
            agentRoot: '/tmp/agents/curly',
            projectRoot: '/tmp/project',
            cwd: '/tmp/project',
            runMode: 'task',
            bundle: { kind: 'agent-default' },
            harness: { provider: 'openai', interactive: true },
          }),
          launchRoleScopedRun: async (input) => {
            await input.onEvent?.({
              type: 'message_end',
              messageId: 'assistant-ack',
              message: { role: 'assistant', content: 'Visible response' },
            })

            return { runId: 'launch-run-ack', sessionId: 'session-ack' }
          },
        }
      )
    } finally {
      conversation.close()
    }
  })

  test('gateway delivery failure advances the linked assistant turn to failed', async () => {
    const conversation = createConversationStoreSpy()

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
            createdAt: '2026-04-23T12:15:00.000Z',
            updatedAt: '2026-04-23T12:15:00.000Z',
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
              content: 'Reply please.',
            },
          })
          const payload = await fixture.json<{ runId: string }>(response)
          const [delivery] = fixture.interfaceStore.deliveries.listQueuedForGateway('discord_prod')

          expect(response.status).toBe(201)
          expect(delivery).toBeDefined()

          conversation.seedTurn({
            turnId: 'turn_assistant',
            threadId: 'thread_0001',
            role: 'assistant',
            body: 'Visible response',
            renderState: 'pending',
            links: {
              runId: payload.runId,
              deliveryRequestId: delivery?.deliveryRequestId,
            },
            actor: { kind: 'agent', id: 'curly' },
            sentAt: '2026-04-23T12:15:05.000Z',
          })

          const failResponse = await fixture.request({
            method: 'POST',
            path: `/v1/gateway/deliveries/${delivery?.deliveryRequestId}/fail`,
            body: {
              code: 'gateway_timeout',
              message: 'Discord webhook timed out.',
            },
          })

          expect(failResponse.status).toBe(200)
          expect(conversation.updateRenderStateCalls).toEqual([
            { turnId: 'turn_assistant', nextState: 'failed' },
          ])
        },
        {
          conversationStore: conversation.store,
          runtimeResolver: async () => ({
            agentRoot: '/tmp/agents/curly',
            projectRoot: '/tmp/project',
            cwd: '/tmp/project',
            runMode: 'task',
            bundle: { kind: 'agent-default' },
            harness: { provider: 'openai', interactive: true },
          }),
          launchRoleScopedRun: async (input) => {
            await input.onEvent?.({
              type: 'message_end',
              messageId: 'assistant-fail',
              message: { role: 'assistant', content: 'Visible response' },
            })

            return { runId: 'launch-run-fail', sessionId: 'session-fail' }
          },
        }
      )
    } finally {
      conversation.close()
    }
  })

  test('POST /v1/messages returns 410 after P1.8 rename', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request({
        method: 'POST',
        path: '/v1/messages',
        body: {
          projectId: fixture.seed.projectId,
          event: {
            ts: '2026-04-23T12:20:01.000Z',
            kind: 'message.posted',
            content: { kind: 'text', body: 'coordination note' },
            links: { runId: 'run_existing' },
          },
        },
      })

      expect(response.status).toBe(410)
    })
  })
})
