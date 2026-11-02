import { expect, test } from 'bun:test'
import { MessageType } from 'discord.js'
import { withWiredServer } from '../../../acp-server/test/fixtures/wired-server.js'
import { GatewayDiscordApp } from '../app.js'
import { type CapturedInterfaceMessage, createFetch } from './app-acp-fixture.test.js'
import { FakeChannel, FakeClient, createClient } from './app-discord-fixture.test.js'

/** Register in the parent suite to retain the original test identities and order. */
export function registerThreadIngressTests(): void {
  test('refreshes a parent-channel fallback before routing a thread with a new exact binding', async () => {
    const threadChannel = new FakeChannel('thread_exact_late')
    const client = createClient(threadChannel)
    const captured: CapturedInterfaceMessage[] = []
    let bindingListCalls = 0

    const parentBinding = {
      bindingId: 'ifb_parent_cached',
      gatewayId: 'discord_prod',
      conversationRef: 'channel:chan_parent_cached',
      scopeRef: 'agent:sparky:project:agent-spaces:task:parent',
      laneRef: 'main',
      projectId: 'agent-spaces',
      status: 'active',
      createdAt: '2026-05-07T10:00:00.000Z',
      updatedAt: '2026-05-07T10:00:00.000Z',
    }
    const exactThreadBinding = {
      bindingId: 'ifb_thread_exact_late',
      gatewayId: 'discord_prod',
      conversationRef: 'channel:chan_parent_cached',
      threadRef: 'thread:thread_exact_late',
      scopeRef: 'agent:cody:project:agent-spaces:task:thread-exact',
      laneRef: 'main',
      projectId: 'agent-spaces',
      status: 'active',
      createdAt: '2026-05-07T10:01:00.000Z',
      updatedAt: '2026-05-07T10:01:00.000Z',
    }

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

        if (url.pathname === '/v1/interface/bindings') {
          bindingListCalls += 1
          return Response.json({
            bindings:
              bindingListCalls === 1 ? [parentBinding] : [parentBinding, exactThreadBinding],
          })
        }

        if (url.pathname === '/v1/interface/messages') {
          captured.push((await request.json()) as CapturedInterfaceMessage)
          return Response.json({
            inputAttemptId: 'ia_thread_exact',
            runId: 'run_thread_exact',
          })
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
      content: 'route this exact thread binding',
      attachments: { size: 0 },
      channelId: 'thread_exact_late',
      id: 'msg_thread_exact',
      channel: {
        isThread: () => true,
        parentId: 'chan_parent_cached',
      },
      reply: async () => undefined,
    } as never)

    expect(bindingListCalls).toBe(2)
    expect(captured[0]?.source).toMatchObject({
      gatewayId: 'discord_prod',
      conversationRef: 'channel:chan_parent_cached',
      threadRef: 'thread:thread_exact_late',
      messageRef: 'discord:message:msg_thread_exact',
    })

    const webhook = [...threadChannel.webhooks.values()].find((w) => w.name === 'agent-pulpit')
    expect(webhook?.sent[0]?.content).toContain('cody@agent-spaces:thread-exact~main')
    expect(webhook?.sent[0]?.content).not.toContain('sparky@agent-spaces:parent')
  })

  test('ignores Discord thread-created system messages in bound parent channels', async () => {
    const client = new FakeClient()
    const captured: CapturedInterfaceMessage[] = []

    const app = new GatewayDiscordApp({
      acpBaseUrl: 'http://acp.test',
      gatewayId: 'discord_prod',
      client: client as never,
      fetchImpl: createFetch(async (request) => {
        const url = new URL(request.url)

        if (url.pathname === '/v1/interface/bindings') {
          return Response.json({
            bindings: [
              {
                bindingId: 'ifb_parent_thread_created',
                gatewayId: 'discord_prod',
                conversationRef: 'channel:chan_parent',
                scopeRef: 'agent:cody:project:agent-spaces:task:parent',
                laneRef: 'main',
                projectId: 'agent-spaces',
                status: 'active',
                createdAt: '2026-05-09T02:00:00.000Z',
                updatedAt: '2026-05-09T02:00:00.000Z',
              },
            ],
          })
        }

        if (url.pathname === '/v1/interface/messages') {
          captured.push((await request.json()) as CapturedInterfaceMessage)
          return Response.json({
            inputAttemptId: 'ia_unexpected',
            runId: 'run_unexpected',
          })
        }

        return new Response('not found', { status: 404 })
      }),
      dashboardSnapshotImpl: async () => ({
        type: 'dashboard_snapshot',
        sessions: [],
      }),
    })

    await app.refreshBindings()
    await app.handleMessageCreate({
      guildId: 'guild_1',
      type: MessageType.ThreadCreated,
      author: { id: '1165644636807778414', bot: true },
      content: 'T-01389 app-server smoke',
      attachments: { size: 0 },
      channelId: 'chan_parent',
      id: 'msg_thread_created',
      channel: {
        isThread: () => false,
      },
      reply: async () => undefined,
    } as never)

    expect(captured).toHaveLength(0)
  })

  test('ingresses a Discord message, reuses the placeholder, and acks delivery', async () => {
    await withWiredServer(async (fixture) => {
      fixture.interfaceStore.bindings.create({
        bindingId: 'ifb_123',
        gatewayId: 'discord_prod',
        conversationRef: 'channel:chan_1',
        threadRef: 'thread:thread_1',
        scopeRef: `agent:curly:project:${fixture.seed.projectId}`,
        laneRef: 'main',
        projectId: fixture.seed.projectId,
        status: 'active',
        createdAt: '2026-04-20T15:00:00.000Z',
        updatedAt: '2026-04-20T15:00:00.000Z',
      })

      const threadChannel = new FakeChannel('thread_1')
      const client = createClient(threadChannel)

      const app = new GatewayDiscordApp({
        acpBaseUrl: 'http://acp.test',
        gatewayId: 'discord_prod',
        client: client as never,
        fetchImpl: createFetch(fixture.handler),
      })

      await app.refreshBindings()

      const inboundMessage = {
        guildId: 'guild_1',
        author: { id: 'user_1', bot: false },
        content: 'Please summarize the status.',
        attachments: { size: 0 },
        channelId: 'thread_1',
        id: '123',
        channel: {
          isThread: () => true,
          parentId: 'chan_1',
        },
        reply: async () => undefined,
      } as never

      await app.handleMessageCreate(inboundMessage)

      // Placeholder now routes through the agent webhook, not channel.send
      expect(threadChannel.sent).toHaveLength(0)
      const webhook = [...threadChannel.webhooks.values()].find((w) => w.name === 'agent-pulpit')
      expect(webhook).toBeDefined()
      expect(webhook?.sent).toHaveLength(1)
      expect(webhook?.sent[0]?.content).toContain('⏳ **Processing:**')

      const runId = fixture.runStore.listRuns()[0]?.runId
      expect(runId).toBeDefined()

      fixture.interfaceStore.deliveries.enqueue({
        deliveryRequestId: 'dr_123',
        gatewayId: 'discord_prod',
        bindingId: 'ifb_123',
        scopeRef: `agent:curly:project:${fixture.seed.projectId}`,
        laneRef: 'main',
        runId,
        conversationRef: 'channel:chan_1',
        threadRef: 'thread:thread_1',
        replyToMessageRef: 'discord:message:123',
        bodyKind: 'text/markdown',
        bodyText: 'Final answer',
        createdAt: '2026-04-20T15:01:00.000Z',
      })

      await app.pollDeliveriesOnce()

      // Finalization edits via the same webhook, not bot client
      expect(webhook?.edits).toHaveLength(1)
      expect(webhook?.edits[0]?.payload.content).toContain('Final answer')
      expect(fixture.interfaceStore.deliveries.get('dr_123')?.status).toBe('delivered')
    })
  })

  test('nt creates a Discord thread, binds it to a lane-scoped session, and dispatches stripped content', async () => {
    await withWiredServer(async (fixture) => {
      fixture.interfaceStore.bindings.create({
        bindingId: 'ifb_nt_parent',
        gatewayId: 'discord_prod',
        conversationRef: 'channel:chan_nt',
        scopeRef: `agent:curly:project:${fixture.seed.projectId}`,
        laneRef: 'main',
        projectId: fixture.seed.projectId,
        status: 'active',
        createdAt: '2026-04-20T15:00:00.000Z',
        updatedAt: '2026-04-20T15:00:00.000Z',
      })

      const parentChannel = new FakeChannel('chan_nt')
      const threadChannel = new FakeChannel('thread_nt_1')
      const client = createClient(parentChannel, threadChannel)
      const startThreadCalls: Array<{ name: string }> = []

      const app = new GatewayDiscordApp({
        acpBaseUrl: 'http://acp.test',
        gatewayId: 'discord_prod',
        client: client as never,
        fetchImpl: createFetch(fixture.handler),
      })

      await app.refreshBindings()

      const inboundMessage = {
        guildId: 'guild_1',
        author: { id: 'user_1', bot: false },
        content: 'nt implement a new feature XTZ',
        attachments: { size: 0 },
        channelId: 'chan_nt',
        id: 'msg_nt_1',
        channel: {
          isThread: () => false,
        },
        reply: async () => undefined,
        startThread: async (options: { name: string }) => {
          startThreadCalls.push(options)
          return { id: 'thread_nt_1' }
        },
      } as never

      await app.handleMessageCreate(inboundMessage)

      expect(startThreadCalls).toEqual([{ name: 'implement a new feature XTZ' }])
      expect(parentChannel.sent).toHaveLength(0)
      // Placeholder now routes through the agent webhook
      expect(threadChannel.sent).toHaveLength(0)
      const webhook = [...threadChannel.webhooks.values()].find((w) => w.name === 'agent-pulpit')
      expect(webhook).toBeDefined()
      expect(webhook?.sent).toHaveLength(1)
      expect(webhook?.sent[0]?.content).toContain('⏳ **Processing:**')
      expect(webhook?.sent[0]?.content).toContain('implement a new feature XTZ')
      expect(webhook?.sent[0]?.content).not.toContain('nt implement')
      // Subtext must reflect the CHILD thread laneRef, not the parent's `main` lane.
      expect(webhook?.sent[0]?.content).toContain('lane:discord-thread_nt_1')
      expect(webhook?.sent[0]?.content).not.toMatch(/^-# .*~main\n/)

      const threadBinding = fixture.interfaceStore.bindings.resolve({
        gatewayId: 'discord_prod',
        conversationRef: 'channel:chan_nt',
        threadRef: 'thread:thread_nt_1',
      })
      expect(threadBinding).toMatchObject({
        gatewayId: 'discord_prod',
        conversationRef: 'channel:chan_nt',
        threadRef: 'thread:thread_nt_1',
        scopeRef: `agent:curly:project:${fixture.seed.projectId}`,
        laneRef: 'lane:discord-thread_nt_1',
        projectId: fixture.seed.projectId,
        status: 'active',
      })

      const runs = fixture.runStore.listRuns()
      expect(runs).toHaveLength(1)
      expect(runs[0]).toMatchObject({
        scopeRef: `agent:curly:project:${fixture.seed.projectId}`,
        laneRef: 'lane:discord-thread_nt_1',
        metadata: { content: 'implement a new feature XTZ' },
      })
    })
  })

  test('nt rejects attempts to create a new thread from inside a thread', async () => {
    await withWiredServer(async (fixture) => {
      fixture.interfaceStore.bindings.create({
        bindingId: 'ifb_nt_existing_thread',
        gatewayId: 'discord_prod',
        conversationRef: 'channel:chan_nt_parent',
        threadRef: 'thread:thread_existing',
        scopeRef: `agent:curly:project:${fixture.seed.projectId}`,
        laneRef: 'lane:discord-thread_existing',
        projectId: fixture.seed.projectId,
        status: 'active',
        createdAt: '2026-04-20T15:00:00.000Z',
        updatedAt: '2026-04-20T15:00:00.000Z',
      })

      const threadChannel = new FakeChannel('thread_existing')
      const client = createClient(threadChannel)
      const replies: string[] = []

      const app = new GatewayDiscordApp({
        acpBaseUrl: 'http://acp.test',
        gatewayId: 'discord_prod',
        client: client as never,
        fetchImpl: createFetch(fixture.handler),
      })

      await app.refreshBindings()

      const inboundMessage = {
        guildId: 'guild_1',
        author: { id: 'user_1', bot: false },
        content: 'nt nested work should not dispatch',
        attachments: { size: 0 },
        channelId: 'thread_existing',
        id: 'msg_nt_thread',
        channel: {
          isThread: () => true,
          parentId: 'chan_nt_parent',
        },
        reply: async (content: string) => {
          replies.push(content)
        },
        startThread: async () => {
          throw new Error('startThread should not be called')
        },
      } as never

      await app.handleMessageCreate(inboundMessage)

      expect(replies).toEqual(['`nt` can only start a thread from a bound channel.'])
      expect(threadChannel.sent).toHaveLength(0)
      expect(fixture.runStore.listRuns()).toHaveLength(0)
    })
  })

  test('nt duplicate handling reuses the created thread within the gateway process', async () => {
    await withWiredServer(async (fixture) => {
      fixture.interfaceStore.bindings.create({
        bindingId: 'ifb_nt_duplicate_parent',
        gatewayId: 'discord_prod',
        conversationRef: 'channel:chan_nt_dup',
        scopeRef: `agent:curly:project:${fixture.seed.projectId}`,
        laneRef: 'main',
        projectId: fixture.seed.projectId,
        status: 'active',
        createdAt: '2026-04-20T15:00:00.000Z',
        updatedAt: '2026-04-20T15:00:00.000Z',
      })

      const parentChannel = new FakeChannel('chan_nt_dup')
      const threadChannel = new FakeChannel('thread_nt_dup')
      const client = createClient(parentChannel, threadChannel)
      let startThreadCount = 0

      const app = new GatewayDiscordApp({
        acpBaseUrl: 'http://acp.test',
        gatewayId: 'discord_prod',
        client: client as never,
        fetchImpl: createFetch(fixture.handler),
      })

      await app.refreshBindings()

      const inboundMessage = {
        guildId: 'guild_1',
        author: { id: 'user_1', bot: false },
        content: 'nt duplicate-safe prompt',
        attachments: { size: 0 },
        channelId: 'chan_nt_dup',
        id: 'msg_nt_dup',
        channel: {
          isThread: () => false,
        },
        reply: async () => undefined,
        startThread: async () => {
          startThreadCount += 1
          return { id: 'thread_nt_dup' }
        },
      } as never

      await app.handleMessageCreate(inboundMessage)
      await app.handleMessageCreate(inboundMessage)

      expect(startThreadCount).toBe(1)
      expect(
        fixture.interfaceStore.bindings.list({
          gatewayId: 'discord_prod',
          conversationRef: 'channel:chan_nt_dup',
          threadRef: 'thread:thread_nt_dup',
        })
      ).toHaveLength(1)
      expect(fixture.runStore.listRuns()).toHaveLength(1)
    })
  })
}
