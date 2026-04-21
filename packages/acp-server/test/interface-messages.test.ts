import { describe, expect, test } from 'bun:test'

import { withWiredServer } from './fixtures/wired-server.js'

describe('POST /v1/interface/messages', () => {
  test('creates an input attempt, records the source, and dispatches once', async () => {
    const launches: Array<{
      sessionRef: { scopeRef: string; laneRef: string }
      intent: { initialPrompt?: string }
    }> = []

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
          createdAt: '2026-04-20T15:00:00.000Z',
          updatedAt: '2026-04-20T15:00:00.000Z',
        })

        const firstResponse = await fixture.request({
          method: 'POST',
          path: '/v1/interface/messages',
          body: {
            idempotencyKey: 'discord:message:123',
            source: {
              gatewayId: 'discord_prod',
              conversationRef: 'channel:123',
              messageRef: 'discord:message:123',
              authorRef: 'discord:user:999',
            },
            content: 'Please summarize the status of T-01144.',
          },
        })
        const firstPayload = await fixture.json<{ inputAttemptId: string; runId: string }>(
          firstResponse
        )

        expect(firstResponse.status).toBe(201)
        expect(firstPayload.inputAttemptId).toMatch(/^ia_/)
        expect(firstPayload.runId).toMatch(/^run_/)

        const run = fixture.runStore.getRun(firstPayload.runId)
        expect(run?.metadata).toMatchObject({
          actorAgentId: 'discord:user:999',
          content: 'Please summarize the status of T-01144.',
        })
        expect(
          (run?.metadata?.meta as Record<string, unknown> | undefined)?.['interfaceSource']
        ).toEqual({
          gatewayId: 'discord_prod',
          bindingId: 'ifb_123',
          conversationRef: 'channel:123',
          messageRef: 'discord:message:123',
          authorRef: 'discord:user:999',
          replyToMessageRef: 'discord:message:123',
          clientIdempotencyKey: 'discord:message:123',
        })

        expect(
          fixture.interfaceStore.messageSources.getByMessageRef(
            'discord_prod',
            'discord:message:123'
          )
        ).toEqual({
          gatewayId: 'discord_prod',
          bindingId: 'ifb_123',
          conversationRef: 'channel:123',
          messageRef: 'discord:message:123',
          authorRef: 'discord:user:999',
          receivedAt: expect.any(String),
        })

        const secondResponse = await fixture.request({
          method: 'POST',
          path: '/v1/interface/messages',
          body: {
            idempotencyKey: 'discord:message:123',
            source: {
              gatewayId: 'discord_prod',
              conversationRef: 'channel:123',
              messageRef: 'discord:message:123',
              authorRef: 'discord:user:999',
            },
            content: 'Please summarize the status of T-01144.',
          },
        })
        const secondPayload = await fixture.json<{ inputAttemptId: string; runId: string }>(
          secondResponse
        )

        expect(secondResponse.status).toBe(200)
        expect(secondPayload).toEqual(firstPayload)
        expect(launches).toHaveLength(1)
        expect(launches[0]).toMatchObject({
          sessionRef: {
            scopeRef: `agent:curly:project:${fixture.seed.projectId}`,
            laneRef: 'main',
          },
          intent: {
            initialPrompt: 'Please summarize the status of T-01144.',
          },
        })
      },
      {
        runtimeResolver: async () => ({
          agentRoot: '/tmp/agents/curly',
          projectRoot: '/tmp/project',
          cwd: '/tmp/project',
          runMode: 'task',
          bundle: { kind: 'agent-default' },
          harness: { provider: 'openai', interactive: true },
        }),
        launchRoleScopedRun: async (input) => {
          launches.push(input)
          return { runId: 'launch-run-001', sessionId: 'session-001' }
        },
      }
    )
  })

  test('wires launch session events into outbound delivery capture', async () => {
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
          createdAt: '2026-04-20T15:00:00.000Z',
          updatedAt: '2026-04-20T15:00:00.000Z',
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

        expect(response.status).toBe(201)
        expect(
          fixture.interfaceStore.deliveries.listQueuedForGateway('discord_prod')
        ).toMatchObject([
          {
            bindingId: 'ifb_123',
            conversationRef: 'channel:123',
            replyToMessageRef: 'discord:message:789',
            bodyText: 'Visible response',
            status: 'queued',
          },
        ])
      },
      {
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
  })

  test('returns interface_binding_not_found when no active binding exists', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request({
        method: 'POST',
        path: '/v1/interface/messages',
        body: {
          source: {
            gatewayId: 'discord_prod',
            conversationRef: 'channel:404',
            messageRef: 'discord:message:404',
            authorRef: 'discord:user:404',
          },
          content: 'Anyone there?',
        },
      })
      const payload = await fixture.json<{ error: { code: string } }>(response)

      expect(response.status).toBe(404)
      expect(payload.error.code).toBe('interface_binding_not_found')
    })
  })
})
