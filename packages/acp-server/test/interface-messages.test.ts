import { describe, expect, test } from 'bun:test'
import { createInMemoryAdminStore } from 'acp-admin-store'
import type { HrcRuntimeIntent } from 'hrc-core'

import {
  bindDiscordConversation,
  postDiscordMessage,
  resolveCurlyRuntime,
} from './fixtures/discord-interface-message.js'
import { withWiredServer } from './fixtures/wired-server.js'

describe('POST /v1/interface/messages', () => {
  test('uses the registered project root for project-scoped interface dispatch', async () => {
    const adminStore = createInMemoryAdminStore()
    const agentRoot = '/agents/rex'
    const projectRoot = '/projects/dnd-friends'
    const launches: Array<{
      sessionRef: { scopeRef: string; laneRef: string }
      intent: HrcRuntimeIntent
    }> = []

    try {
      adminStore.projects.create({
        projectId: 'dnd-friends',
        displayName: 'DND Friends',
        rootDir: projectRoot,
        actor: { kind: 'agent', id: 'acp-server', displayName: 'ACP Server' },
        now: '2026-05-05T00:00:00.000Z',
      })

      await withWiredServer(
        async (fixture) => {
          fixture.interfaceStore.bindings.create({
            bindingId: 'ifb_rex_dnd',
            gatewayId: 'discord_prod',
            conversationRef: 'channel:1452036862813409310',
            scopeRef: 'agent:rex:project:dnd-friends',
            laneRef: 'main',
            projectId: 'dnd-friends',
            status: 'active',
            createdAt: '2026-05-05T00:00:00.000Z',
            updatedAt: '2026-05-05T00:00:00.000Z',
          })

          const response = await postDiscordMessage(fixture, {
            conversationRef: 'channel:1452036862813409310',
            messageRef: 'discord:message:placement',
            authorRef: 'discord:user:999',
            idempotencyKey: 'discord:message:placement',
            content: 'placement smoke',
          })

          expect(response.status).toBe(201)
          expect(launches).toHaveLength(1)
          expect(launches[0]?.sessionRef).toEqual({
            scopeRef: 'agent:rex:project:dnd-friends',
            laneRef: 'main',
          })
          expect(launches[0]?.intent.placement).toMatchObject({
            agentRoot,
            projectRoot,
            cwd: projectRoot,
            bundle: {
              kind: 'agent-project',
              agentName: 'rex',
              projectRoot,
            },
          })
        },
        {
          adminStore,
          runtimeResolver: async () => ({
            agentRoot,
            projectRoot: agentRoot,
            cwd: agentRoot,
            runMode: 'task',
            bundle: { kind: 'compose', compose: [] },
            harness: { provider: 'openai', interactive: true },
          }),
          placementFetch: async () => ({
            agentRoot,
            projectRoot,
            cwd: projectRoot,
            bundle: { kind: 'agent-project', agentName: 'rex', projectRoot },
            harness: { provider: 'openai', interactive: true },
          }),
          launchRoleScopedRun: async (input) => {
            launches.push(input)
            return {
              runId: 'launch-run-placement',
              sessionId: 'session-placement',
            }
          },
        }
      )
    } finally {
      adminStore.close()
    }
  })

  test('creates an input attempt, records the source, and dispatches once', async () => {
    const launches: Array<{
      sessionRef: { scopeRef: string; laneRef: string }
      intent: {
        initialPrompt?: string
        attachments?: Array<Record<string, unknown>>
      }
    }> = []

    await withWiredServer(
      async (fixture) => {
        bindDiscordConversation(fixture, {
          bindingId: 'ifb_123',
          conversationRef: 'channel:123',
        })

        const message = {
          conversationRef: 'channel:123',
          messageRef: 'discord:message:123',
          authorRef: 'discord:user:999',
          idempotencyKey: 'discord:message:123',
          content: 'Please summarize the status of T-01144.',
        }
        const firstResponse = await postDiscordMessage(fixture, message)
        const firstPayload = await fixture.json<{
          inputAttemptId: string
          runId: string
        }>(firstResponse)

        expect(firstResponse.status).toBe(201)
        expect(firstPayload.inputAttemptId).toMatch(/^ia_/)
        expect(firstPayload.runId).toMatch(/^run_/)

        const run = fixture.runStore.getRun(firstPayload.runId)
        expect(run?.metadata).toMatchObject({
          content: 'Please summarize the status of T-01144.',
          meta: {
            interfaceSource: {
              authorRef: 'discord:user:999',
            },
          },
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
          'attachments' in ((run?.metadata?.meta as Record<string, unknown> | undefined) ?? {})
        ).toBe(false)

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

        const secondResponse = await postDiscordMessage(fixture, message)
        const secondPayload = await fixture.json<{
          inputAttemptId: string
          runId: string
        }>(secondResponse)

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
        runtimeResolver: resolveCurlyRuntime,
        launchRoleScopedRun: async (input) => {
          launches.push(input)
          return { runId: 'launch-run-001', sessionId: 'session-001' }
        },
      }
    )
  })

  test('returns hostSessionId and generation after launch resolves', async () => {
    await withWiredServer(
      async (fixture) => {
        bindDiscordConversation(fixture, {
          bindingId: 'ifb_live_events',
          conversationRef: 'channel:live-events',
        })

        const response = await postDiscordMessage(fixture, {
          conversationRef: 'channel:live-events',
          messageRef: 'discord:message:live-events',
          authorRef: 'discord:user:999',
          idempotencyKey: 'discord:message:live-events',
          content: 'start live stream',
        })
        const payload = await fixture.json<{
          inputAttemptId: string
          runId: string
          hostSessionId: string
          generation: number
        }>(response)

        expect(response.status).toBe(201)
        expect(payload.inputAttemptId).toMatch(/^ia_/)
        expect(payload.runId).toMatch(/^run_/)
        expect(payload.hostSessionId).toBe('hsid-interface-live')
        expect(payload.generation).toBe(6)
      },
      {
        runtimeResolver: resolveCurlyRuntime,
        launchRoleScopedRun: async ({ acpRunId, runStore }) => {
          if (acpRunId !== undefined && runStore !== undefined) {
            runStore.updateRun(acpRunId, {
              hrcRunId: 'hrc-run-interface-live',
              hostSessionId: 'hsid-interface-live',
              generation: 6,
              runtimeId: 'rt-interface-live',
              transport: 'headless',
              status: 'running',
            })
          }

          return {
            runId: 'hrc-run-interface-live',
            sessionId: 'hsid-interface-live',
            hostSessionId: 'hsid-interface-live',
            generation: 6,
          }
        },
      }
    )
  })

  test('wires launch session events into outbound delivery capture', async () => {
    await withWiredServer(
      async (fixture) => {
        bindDiscordConversation(fixture, {
          bindingId: 'ifb_123',
          conversationRef: 'channel:123',
        })

        const response = await postDiscordMessage(fixture, {
          conversationRef: 'channel:123',
          messageRef: 'discord:message:789',
          authorRef: 'discord:user:999',
          content: 'Reply please.',
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
        runtimeResolver: resolveCurlyRuntime,
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
      const response = await postDiscordMessage(fixture, {
        conversationRef: 'channel:404',
        messageRef: 'discord:message:404',
        authorRef: 'discord:user:404',
        content: 'Anyone there?',
      })
      const payload = await fixture.json<{ error: { code: string } }>(response)

      expect(response.status).toBe(404)
      expect(payload.error.code).toBe('interface_binding_not_found')
    })
  })
})
