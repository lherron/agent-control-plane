/**
 * Regression tests for T-01193: assistant conversation_turn renderState stuck at pending.
 *
 * Verifies that the assistant turn's linksDeliveryRequestId is back-linked at
 * delivery-request creation time so that the ack/fail handlers can find the
 * turn and advance its renderState.
 */
import { describe, expect, test } from 'bun:test'

import { createInMemoryConversationStore } from 'acp-conversation'

import { withWiredServer } from './fixtures/wired-server.js'

describe('delivery render-state regression (T-01193)', () => {
  test('ack advances assistant turn renderState from pending to delivered without manual seeding', async () => {
    const conversationStore = createInMemoryConversationStore()

    try {
      await withWiredServer(
        async (fixture) => {
          fixture.interfaceStore.bindings.create({
            bindingId: 'ifb_reg_ack',
            gatewayId: 'discord_prod',
            conversationRef: 'channel:regression_ack',
            scopeRef: `agent:curly:project:${fixture.seed.projectId}`,
            laneRef: 'main',
            projectId: fixture.seed.projectId,
            status: 'active',
            createdAt: '2026-04-23T13:00:00.000Z',
            updatedAt: '2026-04-23T13:00:00.000Z',
          })

          // 1. Post a message → creates human turn + dispatches run → assistant turn + delivery request
          const response = await fixture.request({
            method: 'POST',
            path: '/v1/interface/messages',
            body: {
              source: {
                gatewayId: 'discord_prod',
                conversationRef: 'channel:regression_ack',
                messageRef: 'discord:message:reg_ack',
                authorRef: 'discord:user:tester',
              },
              content: 'Trigger ack regression test.',
            },
          })

          expect(response.status).toBe(201)

          // 2. Verify delivery request was enqueued
          const deliveries = fixture.interfaceStore.deliveries.listQueuedForGateway('discord_prod')
          expect(deliveries).toHaveLength(1)
          const delivery = deliveries[0]!

          // 3. Verify the assistant turn exists and has linksDeliveryRequestId back-linked
          const assistantTurn = conversationStore.findTurnByLink(
            'linksDeliveryRequestId',
            delivery.deliveryRequestId
          )
          expect(assistantTurn).toBeDefined()
          expect(assistantTurn!.role).toBe('assistant')
          expect(assistantTurn!.renderState).toBe('pending')

          // 4. Ack the delivery
          const ackResponse = await fixture.request({
            method: 'POST',
            path: `/v1/gateway/deliveries/${delivery.deliveryRequestId}/ack`,
          })

          expect(ackResponse.status).toBe(200)

          // 5. Verify renderState advanced to delivered
          const updatedTurn = conversationStore.findTurnByLink(
            'linksDeliveryRequestId',
            delivery.deliveryRequestId
          )
          expect(updatedTurn).toBeDefined()
          expect(updatedTurn!.renderState).toBe('delivered')
        },
        {
          conversationStore,
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
              messageId: 'assistant-reg-ack',
              message: { role: 'assistant', content: 'Regression ack response' },
            })

            return { runId: 'launch-run-reg-ack', sessionId: 'session-reg-ack' }
          },
        }
      )
    } finally {
      conversationStore.close()
    }
  })

  test('fail advances assistant turn renderState from pending to failed without manual seeding', async () => {
    const conversationStore = createInMemoryConversationStore()

    try {
      await withWiredServer(
        async (fixture) => {
          fixture.interfaceStore.bindings.create({
            bindingId: 'ifb_reg_fail',
            gatewayId: 'discord_prod',
            conversationRef: 'channel:regression_fail',
            scopeRef: `agent:curly:project:${fixture.seed.projectId}`,
            laneRef: 'main',
            projectId: fixture.seed.projectId,
            status: 'active',
            createdAt: '2026-04-23T13:05:00.000Z',
            updatedAt: '2026-04-23T13:05:00.000Z',
          })

          // 1. Post a message → creates human turn + dispatches run → assistant turn + delivery request
          const response = await fixture.request({
            method: 'POST',
            path: '/v1/interface/messages',
            body: {
              source: {
                gatewayId: 'discord_prod',
                conversationRef: 'channel:regression_fail',
                messageRef: 'discord:message:reg_fail',
                authorRef: 'discord:user:tester',
              },
              content: 'Trigger fail regression test.',
            },
          })

          expect(response.status).toBe(201)

          // 2. Verify delivery request was enqueued
          const deliveries = fixture.interfaceStore.deliveries.listQueuedForGateway('discord_prod')
          expect(deliveries).toHaveLength(1)
          const delivery = deliveries[0]!

          // 3. Verify the assistant turn exists and has linksDeliveryRequestId back-linked
          const assistantTurn = conversationStore.findTurnByLink(
            'linksDeliveryRequestId',
            delivery.deliveryRequestId
          )
          expect(assistantTurn).toBeDefined()
          expect(assistantTurn!.role).toBe('assistant')
          expect(assistantTurn!.renderState).toBe('pending')

          // 4. Fail the delivery
          const failResponse = await fixture.request({
            method: 'POST',
            path: `/v1/gateway/deliveries/${delivery.deliveryRequestId}/fail`,
            body: {
              code: 'gateway_timeout',
              message: 'Discord webhook timed out.',
            },
          })

          expect(failResponse.status).toBe(200)

          // 5. Verify renderState advanced to failed
          const updatedTurn = conversationStore.findTurnByLink(
            'linksDeliveryRequestId',
            delivery.deliveryRequestId
          )
          expect(updatedTurn).toBeDefined()
          expect(updatedTurn!.renderState).toBe('failed')
        },
        {
          conversationStore,
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
              messageId: 'assistant-reg-fail',
              message: { role: 'assistant', content: 'Regression fail response' },
            })

            return { runId: 'launch-run-reg-fail', sessionId: 'session-reg-fail' }
          },
        }
      )
    } finally {
      conversationStore.close()
    }
  })
})
