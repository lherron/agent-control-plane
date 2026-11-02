import { describe, expect, test } from 'bun:test'
import { withWiredServer } from '../../../acp-server/test/fixtures/wired-server.js'
import { GatewayDiscordApp } from '../app.js'
import { type CapturedInterfaceMessage, createFetch } from './app-acp-fixture.test.js'
import { FakeChannel, createClient } from './app-discord-fixture.test.js'

import { registerLedgerResponseTests } from './app-ledger-response-suite.test.js'
import { registerMediaIngressTests } from './app-media-ingress-suite.test.js'
import { registerThreadIngressTests } from './app-thread-ingress-suite.test.js'
import { registerWebhookDeliveryTests } from './app-webhook-delivery-suite.test.js'

// Registration stays explicit: preserve the original suite identity and execution order.
describe('GatewayDiscordApp local e2e', () => {
  test('alerts once per continuous live-progress cursor-prime failure', async () => {
    const jobRunsChannel = new FakeChannel('chan_job_runs')
    const client = createClient(jobRunsChannel)

    const app = new GatewayDiscordApp({
      acpBaseUrl: 'http://acp.test',
      gatewayId: 'discord_prod',
      client: client as never,
      jobRunsChannelId: jobRunsChannel.id,
      dashboardSnapshotImpl: async () => {
        throw new Error('dashboard snapshot websocket closed before snapshot (code=1000)')
      },
      fetchImpl: createFetch(async (request) => {
        const url = new URL(request.url)
        if (url.pathname === '/v1/interface/bindings') {
          return Response.json({
            bindings: [
              {
                bindingId: 'ifb_prime_failure',
                gatewayId: 'discord_prod',
                conversationRef: 'channel:chan_bound',
                scopeRef: 'agent:cody:project:agent-control-plane',
                laneRef: 'main',
                projectId: 'agent-control-plane',
                status: 'active',
                createdAt: '2026-08-22T20:00:00.000Z',
                updatedAt: '2026-08-22T20:00:00.000Z',
              },
            ],
          })
        }
        return new Response('not found', { status: 404 })
      }),
    })

    await app.refreshBindings()
    await app.refreshBindings()

    const webhook = [...jobRunsChannel.webhooks.values()].find(
      (item) => item.name === 'agent-pulpit'
    )
    expect(webhook?.sent).toHaveLength(1)
    expect(webhook?.sent[0]?.content).toContain('Gateway live progress disabled')
    expect(webhook?.sent[0]?.content).toContain('code=1000')
  })

  test('steers ordinary Discord messages by default when active contribution is available', async () => {
    const channel = new FakeChannel('chan_steer_default')
    const client = createClient(channel)
    const paths: string[] = []
    const captured: CapturedInterfaceMessage[] = []

    const app = new GatewayDiscordApp({
      acpBaseUrl: 'http://acp.test',
      gatewayId: 'discord_prod',
      client: client as never,
      dashboardSnapshotImpl: async () => ({
        type: 'dashboard_snapshot',
        sessions: [
          {
            sessionRef: 'agent:cody:project:agent-spaces/lane:main',
            status: 'active',
            summaryStatus: 'active',
            activeTurnId: 'hrc_run_active',
            capabilities: { input: true },
          },
        ],
      }),
      fetchImpl: createFetch(async (request) => {
        const url = new URL(request.url)
        paths.push(url.pathname)

        if (url.pathname === '/v1/interface/bindings') {
          return Response.json({
            bindings: [
              {
                bindingId: 'ifb_steer_default',
                gatewayId: 'discord_prod',
                conversationRef: 'channel:chan_steer_default',
                scopeRef: 'agent:cody:project:agent-spaces',
                laneRef: 'main',
                sessionRef: {
                  scopeRef: 'agent:cody:project:agent-spaces',
                  laneRef: 'main',
                },
                projectId: 'agent-spaces',
                status: 'active',
                createdAt: '2026-05-07T10:00:00.000Z',
                updatedAt: '2026-05-07T10:00:00.000Z',
              },
            ],
          })
        }

        if (url.pathname === '/v1/interface/messages') {
          captured.push((await request.json()) as CapturedInterfaceMessage)
          return Response.json(
            {
              inputAttemptId: 'ia_steered',
              targetRunId: 'run_active',
              admission: {
                kind: 'accepted_in_flight',
                inputAttemptId: 'ia_steered',
                inputApplicationId: 'iap_steered',
              },
              currentState: {
                applicationStatus: 'accepted',
                inputApplicationId: 'iap_steered',
              },
            },
            { status: 201 }
          )
        }

        if (url.pathname === '/v1/session-refs/events') {
          return new Response(new ReadableStream())
        }

        return new Response('not found', { status: 404 })
      }),
    })

    await app.refreshBindings()
    await app.handleMessageCreate({
      guildId: 'guild_1',
      author: { id: 'user_1', bot: false },
      content: 'fold the new context into the active task',
      attachments: { size: 0 },
      channelId: 'chan_steer_default',
      id: 'msg_steer_default',
      channel: {
        isThread: () => false,
      },
      reply: async () => undefined,
    } as never)

    expect(paths).not.toContain('/v1/inputs')
    expect(captured).toHaveLength(1)
    expect(captured[0]).toMatchObject({
      content: 'fold the new context into the active task',
      intent: {
        kind: 'contribute_to_active_run',
        fallback: 'queue',
        contributionSemantics: 'interrupt_and_continue',
      },
      source: {
        gatewayId: 'discord_prod',
        conversationRef: 'channel:chan_steer_default',
        messageRef: 'discord:message:msg_steer_default',
      },
    })

    const webhook = [...channel.webhooks.values()].find((w) => w.name === 'agent-pulpit')
    expect(webhook?.edits.at(-1)?.payload.content).toContain('↪️ **Steered active run:**')
  })

  registerLedgerResponseTests()

  test('ordinary Discord messages fall back to normal queueing when contribution is unavailable', async () => {
    await withWiredServer(async (fixture) => {
      fixture.interfaceStore.bindings.create({
        bindingId: 'ifb_contribution_unavailable',
        gatewayId: 'discord_prod',
        conversationRef: 'channel:chan_contribution_unavailable',
        scopeRef: `agent:curly:project:${fixture.seed.projectId}`,
        laneRef: 'main',
        projectId: fixture.seed.projectId,
        status: 'active',
        createdAt: '2026-05-07T10:00:00.000Z',
        updatedAt: '2026-05-07T10:00:00.000Z',
      })

      const channel = new FakeChannel('chan_contribution_unavailable')
      const client = createClient(channel)
      const paths: string[] = []

      const app = new GatewayDiscordApp({
        acpBaseUrl: 'http://acp.test',
        gatewayId: 'discord_prod',
        client: client as never,
        dashboardSnapshotImpl: async () => ({
          type: 'dashboard_snapshot',
          sessions: [],
        }),
        fetchImpl: createFetch(async (request) => {
          const url = new URL(request.url)
          paths.push(url.pathname)
          return fixture.handler(request)
        }),
      })

      await app.refreshBindings()
      await app.handleMessageCreate({
        guildId: 'guild_1',
        author: { id: 'user_1', bot: false },
        content: 'add this as queued follow-up if steering is unavailable',
        attachments: { size: 0 },
        channelId: 'chan_contribution_unavailable',
        id: 'msg_contribution_unavailable',
        channel: {
          isThread: () => false,
        },
        reply: async () => undefined,
      } as never)

      expect(paths).not.toContain('/v1/inputs')
      const run = fixture.runStore.listRuns()[0]
      expect(run?.metadata.content).toBe('add this as queued follow-up if steering is unavailable')
      expect(run?.metadata.meta).toMatchObject({
        interfaceSource: {
          gatewayId: 'discord_prod',
          bindingId: 'ifb_contribution_unavailable',
          conversationRef: 'channel:chan_contribution_unavailable',
          messageRef: 'discord:message:msg_contribution_unavailable',
        },
      })
    })
  })

  registerThreadIngressTests()
  registerMediaIngressTests()
  registerWebhookDeliveryTests()

  test('replaces the placeholder with a visible error when ACP fetch throws', async () => {
    // Regression guard: previously, a thrown fetch (ACP down / socket refused)
    // bypassed the `!response.ok` cleanup path, leaving `⏳ Processing` orphaned
    // in the channel forever. The fix must edit the placeholder in place so the
    // user sees the failure at the same location they were watching.
    await withWiredServer(async (fixture) => {
      fixture.interfaceStore.bindings.create({
        bindingId: 'ifb_err',
        gatewayId: 'discord_prod',
        conversationRef: 'channel:chan_err',
        scopeRef: `agent:curly:project:${fixture.seed.projectId}`,
        laneRef: 'main',
        projectId: fixture.seed.projectId,
        status: 'active',
        createdAt: '2026-04-20T15:00:00.000Z',
        updatedAt: '2026-04-20T15:00:00.000Z',
      })

      const channel = new FakeChannel('chan_err')
      const client = createClient(channel)

      // Simulate ACP ingress down (ECONNREFUSED / timeout) but keep binding
      // refresh reachable — the real regression is in the POST, not all traffic.
      const realFetch = createFetch(fixture.handler)
      const throwingFetch: typeof fetch = async (input, init) => {
        const url = input instanceof Request ? input.url : String(input)
        if (url.endsWith('/v1/interface/messages')) {
          throw new Error('ECONNREFUSED: acp.test')
        }
        return realFetch(input, init)
      }

      const app = new GatewayDiscordApp({
        acpBaseUrl: 'http://acp.test',
        gatewayId: 'discord_prod',
        client: client as never,
        fetchImpl: throwingFetch,
      })

      await app.refreshBindings()

      const inboundMessage = {
        guildId: 'guild_1',
        author: { id: 'user_1', bot: false },
        content: 'Please summarize the status.',
        attachments: { size: 0 },
        channelId: 'chan_err',
        id: 'm_err',
        channel: {
          isThread: () => false,
        },
        reply: async () => undefined,
      } as never

      let thrown: unknown
      try {
        await app.handleMessageCreate(inboundMessage)
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(Error)
      expect((thrown as Error).message).toContain('ECONNREFUSED')

      // Placeholder now routes through the agent webhook
      expect(channel.sent).toHaveLength(0)
      const webhook = [...channel.webhooks.values()].find((w) => w.name === 'agent-pulpit')
      expect(webhook).toBeDefined()
      expect(webhook?.sent).toHaveLength(1)
      expect(webhook?.sent[0]?.content).toContain('⏳ **Processing:**')

      // failPlaceholder edits via the same webhook — not deleted, not orphaned.
      expect(webhook?.edits).toHaveLength(1)
      expect(webhook?.edits[0]?.payload.content).toContain('⚠️')
      expect(webhook?.edits[0]?.payload.content).toContain('Could not reach ACP')
      expect(webhook?.edits[0]?.payload.content).toContain('ECONNREFUSED')
    })
  })
})
