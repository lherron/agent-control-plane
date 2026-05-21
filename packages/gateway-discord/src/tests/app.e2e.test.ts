import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MessageType } from 'discord.js'

import type { DeliveryRequest } from 'acp-core'

import { withWiredServer } from '../../../acp-server/test/fixtures/wired-server.js'
import { GatewayDiscordApp } from '../app.js'
import { renderToDiscord } from '../discord-render.js'
import type { RenderFrame } from '../types.js'

type FakeDiscordFile = {
  name?: string | undefined
  description?: string | null | undefined
}

type FakeSendPayload = {
  content: string
  reply?: { messageReference: string } | undefined
  files?: FakeDiscordFile[] | undefined
}

type FakeWebhookSendPayload = FakeSendPayload & {
  username?: string | undefined
  avatarURL?: string | undefined
  avatar_url?: string | undefined
}

class FakeSentMessage {
  constructor(
    readonly id: string,
    readonly channelId: string,
    public content: string
  ) {}

  readonly edits: FakeSendPayload[] = []
  readonly replies: string[] = []
  deleted = false

  async edit(input: string | FakeSendPayload): Promise<this> {
    const payload = typeof input === 'string' ? { content: input } : input
    this.content = payload.content
    this.edits.push(payload)
    return this
  }

  async delete(): Promise<void> {
    this.deleted = true
  }
}

class FakeWebhook {
  readonly sent: Array<FakeWebhookSendPayload & { message: FakeSentMessage }> = []
  readonly edits: Array<{ messageId: string; payload: FakeWebhookSendPayload }> = []
  private nextId = 1

  constructor(
    readonly id: string,
    readonly token: string,
    readonly name: string,
    readonly channelId: string
  ) {}

  async send(input: string | FakeWebhookSendPayload): Promise<FakeSentMessage> {
    const payload = typeof input === 'string' ? { content: input } : input
    const message = new FakeSentMessage(`wh_${this.nextId++}`, this.channelId, payload.content)
    this.sent.push({ ...payload, message })
    return message
  }

  async editMessage(
    messageId: string,
    input: string | FakeWebhookSendPayload
  ): Promise<FakeSentMessage> {
    const payload = typeof input === 'string' ? { content: input } : input
    this.edits.push({ messageId, payload })
    return new FakeSentMessage(messageId, this.channelId, payload.content)
  }
}

class FakeChannel {
  readonly sent: Array<
    FakeSendPayload & { replyTo?: string | undefined; message: FakeSentMessage }
  > = []
  readonly webhooks = new Map<string, FakeWebhook>()
  readonly messages = {
    fetch: async (id: string) => this.messageById.get(id) ?? null,
  }

  private nextId = 1
  private readonly messageById = new Map<string, FakeSentMessage>()

  constructor(readonly id: string) {}

  isTextBased(): true {
    return true
  }

  async send(input: string | FakeSendPayload): Promise<FakeSentMessage> {
    const content = typeof input === 'string' ? input : input.content
    const replyTo = typeof input === 'string' ? undefined : input.reply?.messageReference
    const message = new FakeSentMessage(`m${this.nextId++}`, this.id, content)
    this.sent.push({
      ...(typeof input === 'string' ? { content } : input),
      ...(replyTo !== undefined ? { replyTo } : {}),
      message,
    })
    this.messageById.set(message.id, message)
    return message
  }

  async fetchWebhooks(): Promise<Map<string, FakeWebhook>> {
    return this.webhooks
  }

  async createWebhook(options: { name: string }): Promise<FakeWebhook> {
    const webhook = new FakeWebhook(
      `webhook_${this.webhooks.size + 1}`,
      `token_${this.webhooks.size + 1}`,
      options.name,
      this.id
    )
    this.webhooks.set(webhook.id, webhook)
    return webhook
  }
}

class FakeClient {
  readonly channels = {
    fetch: async (id: string) => this.channelMap.get(id) ?? null,
  }

  readonly user = { id: 'bot-user', tag: 'bot#0001' }
  private readonly channelMap = new Map<string, FakeChannel>()

  addChannel(channel: FakeChannel): void {
    this.channelMap.set(channel.id, channel)
  }

  on(): void {}
  off(): void {}
  once(): void {}
  destroy(): void {}
}

function createFetch(handler: (request: Request) => Promise<Response>) {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(String(input), init)
    return handler(request)
  }
}

type CapturedInterfaceMessage = {
  idempotencyKey?: string
  source?: Record<string, unknown>
  content?: string
  attachments?: Array<Record<string, unknown>>
}

function createAttachment(
  id: string,
  input: Record<string, unknown>
): [string, Record<string, unknown>] {
  return [id, input]
}

function createInboundMessage(input: {
  id: string
  content: string
  attachments?: Map<string, Record<string, unknown>> | undefined
}) {
  return {
    guildId: 'guild_1',
    author: { id: 'user_1', bot: false },
    content: input.content,
    attachments: input.attachments ?? new Map(),
    channelId: 'chan_media',
    id: input.id,
    channel: {
      isThread: () => false,
    },
    reply: async () => undefined,
  } as never
}

async function captureIngressPostForMessage(
  message: ReturnType<typeof createInboundMessage>
): Promise<CapturedInterfaceMessage> {
  const channel = new FakeChannel('chan_media')
  const client = new FakeClient()
  client.addChannel(channel)

  const captured: CapturedInterfaceMessage[] = []
  const fetchImpl = createFetch(async (request) => {
    const url = new URL(request.url)
    if (url.pathname === '/v1/interface/bindings') {
      return Response.json({
        bindings: [
          {
            bindingId: 'ifb_media',
            gatewayId: 'discord_prod',
            conversationRef: 'channel:chan_media',
            scopeRef: 'agent:curly:project:project_media',
            laneRef: 'main',
            projectId: 'project_media',
            status: 'active',
            createdAt: '2026-04-20T15:00:00.000Z',
            updatedAt: '2026-04-20T15:00:00.000Z',
          },
        ],
      })
    }

    if (url.pathname === '/v1/interface/messages') {
      captured.push((await request.json()) as CapturedInterfaceMessage)
      return Response.json({ inputAttemptId: 'ia_media', runId: 'run_media' }, { status: 201 })
    }

    return new Response('not found', { status: 404 })
  })

  const app = new GatewayDiscordApp({
    acpBaseUrl: 'http://acp.test',
    gatewayId: 'discord_prod',
    client: client as never,
    fetchImpl,
  })

  await app.refreshBindings()
  await app.handleMessageCreate(message)

  expect(captured).toHaveLength(1)
  return captured[0] as CapturedInterfaceMessage
}

describe('GatewayDiscordApp local e2e', () => {
  test('steers ordinary Discord messages by default when active contribution is available', async () => {
    const channel = new FakeChannel('chan_steer_default')
    const client = new FakeClient()
    client.addChannel(channel)
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
      const client = new FakeClient()
      client.addChannel(channel)
      const paths: string[] = []

      const app = new GatewayDiscordApp({
        acpBaseUrl: 'http://acp.test',
        gatewayId: 'discord_prod',
        client: client as never,
        dashboardSnapshotImpl: async () => ({ type: 'dashboard_snapshot', sessions: [] }),
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

  test('refreshes a parent-channel fallback before routing a thread with a new exact binding', async () => {
    const threadChannel = new FakeChannel('thread_exact_late')
    const client = new FakeClient()
    client.addChannel(threadChannel)
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
      dashboardSnapshotImpl: async () => ({ type: 'dashboard_snapshot', sessions: [] }),
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
          return Response.json({ inputAttemptId: 'ia_thread_exact', runId: 'run_thread_exact' })
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
          return Response.json({ inputAttemptId: 'ia_unexpected', runId: 'run_unexpected' })
        }

        return new Response('not found', { status: 404 })
      }),
      dashboardSnapshotImpl: async () => ({ type: 'dashboard_snapshot', sessions: [] }),
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
      const client = new FakeClient()
      client.addChannel(threadChannel)

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
      const client = new FakeClient()
      client.addChannel(parentChannel)
      client.addChannel(threadChannel)
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
      const client = new FakeClient()
      client.addChannel(threadChannel)
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
      const client = new FakeClient()
      client.addChannel(parentChannel)
      client.addChannel(threadChannel)
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

  test('ingresses image-only Discord message through ACP and dispatches local image attachment', async () => {
    const mediaStateDir = mkdtempSync(join(tmpdir(), 'gateway-discord-image-ingress-'))
    const launches: Array<{
      intent: {
        initialPrompt?: string | undefined
        attachments?: Array<Record<string, unknown>> | undefined
      }
    }> = []

    try {
      await withWiredServer(
        async (fixture) => {
          fixture.interfaceStore.bindings.create({
            bindingId: 'ifb_image_only',
            gatewayId: 'discord_prod',
            conversationRef: 'channel:chan_media',
            scopeRef: `agent:curly:project:${fixture.seed.projectId}`,
            laneRef: 'main',
            projectId: fixture.seed.projectId,
            status: 'active',
            createdAt: '2026-04-20T15:00:00.000Z',
            updatedAt: '2026-04-20T15:00:00.000Z',
          })

          const channel = new FakeChannel('chan_media')
          const client = new FakeClient()
          client.addChannel(channel)

          const app = new GatewayDiscordApp({
            acpBaseUrl: 'http://acp.test',
            gatewayId: 'discord_prod',
            client: client as never,
            fetchImpl: createFetch(fixture.handler),
          })

          await app.refreshBindings()
          await app.handleMessageCreate(
            createInboundMessage({
              id: 'msg_image_only_e2e',
              content: '',
              attachments: new Map([
                createAttachment('att_photo', {
                  url: 'https://cdn.discordapp.test/attachments/photo.jpg',
                  name: 'photo.jpg',
                  contentType: 'image/jpeg',
                  size: 10,
                }),
              ]),
            })
          )

          // Placeholder now routes through the agent webhook
          expect(channel.sent).toHaveLength(0)
          const webhook = [...channel.webhooks.values()].find((w) => w.name === 'agent-pulpit')
          expect(webhook).toBeDefined()
          expect(webhook?.sent[0]?.content).toContain('⏳ **Processing:**')
          expect(launches).toHaveLength(1)
          const attachment = launches[0]?.intent.attachments?.[0]
          expect(attachment).toMatchObject({
            kind: 'file',
            filename: 'photo.jpg',
            contentType: 'image/jpeg',
            sizeBytes: 10,
          })
          expect(String(attachment?.['path'])).toContain(
            join(mediaStateDir, 'media', 'attachments')
          )
          // ACP appends `[attached file: <path>]` so harnesses without native
          // image-block injection (claude-agent-sdk) can Read the file.
          expect(launches[0]?.intent.initialPrompt).toBe(
            `<media:image> (1 image)\n\n[attached file: ${attachment?.['path']}]`
          )
          expect(readFileSync(String(attachment?.['path']), 'utf8')).toBe('jpeg-bytes')

          const run = fixture.runStore.listRuns()[0]
          expect(run?.metadata.content).toBe('<media:image> (1 image)')
          expect(run?.metadata.meta).toMatchObject({
            attachments: [
              {
                kind: 'url',
                url: 'https://cdn.discordapp.test/attachments/photo.jpg',
                filename: 'photo.jpg',
                contentType: 'image/jpeg',
                sizeBytes: 10,
              },
            ],
            resolvedAttachments: [
              {
                kind: 'file',
                filename: 'photo.jpg',
                contentType: 'image/jpeg',
                sizeBytes: 10,
              },
            ],
          })
        },
        {
          mediaStateDir,
          attachmentFetchImpl: async () =>
            new Response('jpeg-bytes', {
              headers: {
                'content-type': 'image/jpeg',
                'content-length': '10',
              },
            }),
          runtimeResolver: async () => ({
            agentRoot: '/tmp/agents/curly',
            projectRoot: '/tmp/project',
            cwd: '/tmp/project',
            runMode: 'task',
            bundle: { kind: 'compose', compose: [] },
            harness: { provider: 'openai', interactive: true },
          }),
          launchRoleScopedRun: async (input) => {
            launches.push(input)
            return { runId: 'launch-run-image-only', sessionId: 'session-image-only' }
          },
        }
      )
    } finally {
      rmSync(mediaStateDir, { recursive: true, force: true })
    }
  })

  test('posts text plus image attachments to ACP ingress', async () => {
    const body = await captureIngressPostForMessage(
      createInboundMessage({
        id: 'msg_text_image',
        content: 'Please inspect this screenshot.',
        attachments: new Map([
          createAttachment('att_image', {
            url: 'https://cdn.discordapp.test/attachments/screenshot.png',
            name: 'screenshot.png',
            contentType: 'image/png',
            size: 12345,
          }),
        ]),
      })
    )

    expect(body).toMatchObject({
      idempotencyKey: 'discord:message:msg_text_image',
      source: {
        gatewayId: 'discord_prod',
        conversationRef: 'channel:chan_media',
        messageRef: 'discord:message:msg_text_image',
        authorRef: 'discord:user:user_1',
      },
      content: 'Please inspect this screenshot.',
      attachments: [
        {
          kind: 'url',
          url: 'https://cdn.discordapp.test/attachments/screenshot.png',
          filename: 'screenshot.png',
          contentType: 'image/png',
          sizeBytes: 12345,
        },
      ],
    })
  })

  test('posts image-only messages with a media placeholder', async () => {
    const body = await captureIngressPostForMessage(
      createInboundMessage({
        id: 'msg_image_only',
        content: '',
        attachments: new Map([
          createAttachment('att_image', {
            url: 'https://cdn.discordapp.test/attachments/photo.jpg',
            name: 'photo.jpg',
            contentType: 'image/jpeg',
            size: 4096,
          }),
        ]),
      })
    )

    expect(body.content).toBe('<media:image> (1 image)')
    expect(body.attachments).toEqual([
      {
        kind: 'url',
        url: 'https://cdn.discordapp.test/attachments/photo.jpg',
        filename: 'photo.jpg',
        contentType: 'image/jpeg',
        sizeBytes: 4096,
      },
    ])
  })

  test('posts multiple image attachments with a count-aware placeholder', async () => {
    const body = await captureIngressPostForMessage(
      createInboundMessage({
        id: 'msg_many_images',
        content: '   ',
        attachments: new Map([
          createAttachment('att_a', {
            url: 'https://cdn.discordapp.test/attachments/a.png',
            name: 'a.png',
            contentType: 'image/png',
            size: 100,
          }),
          createAttachment('att_b', {
            url: 'https://cdn.discordapp.test/attachments/b.webp',
            name: 'b.webp',
            contentType: 'image/webp',
            size: 200,
          }),
        ]),
      })
    )

    expect(body.content).toBe('<media:image> (2 images)')
    expect(body.attachments).toHaveLength(2)
  })

  test('posts non-image attachments with a document placeholder', async () => {
    const body = await captureIngressPostForMessage(
      createInboundMessage({
        id: 'msg_document',
        content: '',
        attachments: new Map([
          createAttachment('att_pdf', {
            url: 'https://cdn.discordapp.test/attachments/report.pdf',
            name: 'report.pdf',
            contentType: 'application/pdf',
            size: 8192,
          }),
        ]),
      })
    )

    expect(body.content).toBe('<media:document> (1 file)')
    expect(body.attachments).toEqual([
      {
        kind: 'url',
        url: 'https://cdn.discordapp.test/attachments/report.pdf',
        filename: 'report.pdf',
        contentType: 'application/pdf',
        sizeBytes: 8192,
      },
    ])
  })

  test('sends a fresh webhook message without Discord reply references when no placeholder exists', async () => {
    await withWiredServer(async (fixture) => {
      fixture.interfaceStore.bindings.create({
        bindingId: 'ifb_234',
        gatewayId: 'discord_prod',
        conversationRef: 'channel:chan_2',
        scopeRef: `agent:curly:project:${fixture.seed.projectId}`,
        laneRef: 'main',
        projectId: fixture.seed.projectId,
        status: 'active',
        createdAt: '2026-04-20T15:00:00.000Z',
        updatedAt: '2026-04-20T15:00:00.000Z',
      })

      const channel = new FakeChannel('chan_2')
      const client = new FakeClient()
      client.addChannel(channel)

      const app = new GatewayDiscordApp({
        acpBaseUrl: 'http://acp.test',
        gatewayId: 'discord_prod',
        client: client as never,
        fetchImpl: createFetch(fixture.handler),
      })

      await app.refreshBindings()

      const delivery: DeliveryRequest = {
        deliveryRequestId: 'dr_234',
        gatewayId: 'discord_prod',
        bindingId: 'ifb_234',
        sessionRef: {
          scopeRef: `agent:curly:project:${fixture.seed.projectId}`,
          laneRef: 'main',
        },
        conversationRef: 'channel:chan_2',
        replyToMessageRef: 'discord:message:orig_1',
        body: {
          kind: 'text/markdown',
          text: 'Fresh reply',
        },
        status: 'queued',
        createdAt: '2026-04-20T15:01:00.000Z',
      }

      fixture.interfaceStore.deliveries.enqueue({
        deliveryRequestId: delivery.deliveryRequestId,
        gatewayId: delivery.gatewayId,
        bindingId: delivery.bindingId,
        scopeRef: delivery.sessionRef.scopeRef,
        laneRef: delivery.sessionRef.laneRef,
        conversationRef: delivery.conversationRef,
        replyToMessageRef: delivery.replyToMessageRef,
        bodyKind: delivery.body.kind,
        bodyText: delivery.body.text,
        createdAt: delivery.createdAt,
      })

      await app.pollDeliveriesOnce()

      expect(channel.sent).toHaveLength(0)
      const webhook = [...channel.webhooks.values()].find(
        (candidate) => candidate.name === 'agent-pulpit'
      )
      expect(webhook).toBeDefined()
      expect(webhook?.sent).toHaveLength(1)
      expect(webhook?.sent[0]?.content).toBe(`-# curly@${fixture.seed.projectId}~main\nFresh reply`)
      expect(webhook?.sent[0]?.reply).toBeUndefined()
      expect(webhook?.sent[0]?.username).toBe('curly')
      expect(webhook?.sent[0]?.avatar_url ?? webhook?.sent[0]?.avatarURL).toBe(
        'https://api.dicebear.com/7.x/bottts/png?seed=curly'
      )
      expect(fixture.interfaceStore.deliveries.get('dr_234')?.status).toBe('delivered')
    })
  })

  test('attaches render-frame image and media files when editing a placeholder', async () => {
    const priorFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response('media-bytes', {
        headers: {
          'content-length': '11',
          'content-type': 'image/jpeg',
        },
      })) as typeof fetch

    try {
      const channel = new FakeChannel('chan_render_files')
      const client = new FakeClient()
      client.addChannel(channel)
      const placeholder = await channel.send('placeholder')

      const frame: RenderFrame = {
        runId: 'run_render_files',
        projectId: 'project_media',
        phase: 'final',
        blocks: [
          { t: 'markdown', md: 'Final with media' },
          {
            t: 'image',
            data: Buffer.from('inline-bytes').toString('base64'),
            mimeType: 'image/png',
          },
          {
            t: 'media_ref',
            url: 'https://media.acp.test/output.jpg',
            mimeType: 'image/jpeg',
            filename: 'result.jpg',
            alt: 'Rendered media alt',
          },
        ],
        updatedAt: Date.now(),
      }

      await renderToDiscord(
        client as never,
        {
          gatewayId: 'discord_prod',
          kind: 'message',
          id: placeholder.id,
          channelId: channel.id,
        },
        frame,
        2000
      )

      const edit = placeholder.edits.at(-1)
      expect(edit?.content).toContain('Final with media')
      expect(edit?.files?.map((file) => file.name)).toEqual(['image_0.png', 'result.jpg'])
      expect(edit?.files?.at(1)?.description).toBe('Rendered media alt')
    } finally {
      globalThis.fetch = priorFetch
    }
  })

  test('sends delivery body attachments through the agent webhook without reply references', async () => {
    const priorFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response('delivered-bytes', {
        headers: {
          'content-length': '15',
          'content-type': 'image/png',
        },
      })) as typeof fetch

    try {
      const channel = new FakeChannel('chan_delivery_files')
      const client = new FakeClient()
      client.addChannel(channel)

      const app = new GatewayDiscordApp({
        acpBaseUrl: 'http://acp.test',
        gatewayId: 'discord_prod',
        client: client as never,
        fetchImpl: createFetch(async () => Response.json({ bindings: [] })),
      })

      const delivery: DeliveryRequest = {
        deliveryRequestId: 'dr_delivery_files',
        gatewayId: 'discord_prod',
        bindingId: 'ifb_delivery_files',
        sessionRef: {
          scopeRef: 'agent:curly:project:project_media',
          laneRef: 'main',
        },
        conversationRef: 'channel:chan_delivery_files',
        replyToMessageRef: 'discord:message:origin',
        body: {
          kind: 'text/markdown',
          text: 'Here is the generated image.',
          attachments: [
            {
              kind: 'url',
              url: 'https://media.acp.test/generated.png',
              filename: 'generated.png',
              contentType: 'image/png',
              alt: 'Generated image alt text',
            },
          ],
        },
        status: 'queued',
        createdAt: '2026-04-24T23:00:00.000Z',
      }

      await (
        app as unknown as { deliverToDiscord(delivery: DeliveryRequest): Promise<void> }
      ).deliverToDiscord(delivery)

      expect(channel.sent).toHaveLength(0)
      const webhook = [...channel.webhooks.values()].find(
        (candidate) => candidate.name === 'agent-pulpit'
      )
      expect(webhook).toBeDefined()
      expect(webhook?.sent).toHaveLength(1)
      expect(webhook?.sent[0]?.content).toContain(
        '-# curly@project_media~main\nHere is the generated image.'
      )
      expect(webhook?.sent[0]?.reply).toBeUndefined()
      expect(webhook?.sent[0]?.username).toBe('curly')
      expect(webhook?.sent[0]?.avatar_url ?? webhook?.sent[0]?.avatarURL).toBe(
        'https://api.dicebear.com/7.x/bottts/png?seed=curly'
      )
      expect(webhook?.sent[0]?.files?.map((file) => file.name)).toEqual(['generated.png'])
      expect(webhook?.sent[0]?.files?.[0]?.description).toBe('Generated image alt text')
    } finally {
      globalThis.fetch = priorFetch
    }
  })

  test('creates placeholders through the agent webhook with editable webhook metadata', async () => {
    const channel = new FakeChannel('chan_placeholder_identity')
    const client = new FakeClient()
    client.addChannel(channel)

    const app = new GatewayDiscordApp({
      acpBaseUrl: 'http://acp.test',
      gatewayId: 'discord_prod',
      client: client as never,
      fetchImpl: createFetch(async () => Response.json({ bindings: [] })),
    })

    const placeholder = await (
      app as unknown as {
        createPlaceholder(input: {
          message: unknown
          channelId: string
          content: string
          sessionRef: { scopeRef: string; laneRef: string }
        }): Promise<
          | (Record<string, unknown> & {
              id: string
              channelId: string
              webhookId: string
              identity: { agentId: string; subtext: string; avatarUrl: string }
            })
          | undefined
        >
      }
    ).createPlaceholder({
      message: { id: 'incoming_placeholder' },
      channelId: channel.id,
      content: 'Please do the work',
      sessionRef: {
        scopeRef: 'agent:cody:project:agent-spaces:task:T-04321',
        laneRef: 'main',
      },
    })

    expect(channel.sent).toHaveLength(0)
    const webhook = [...channel.webhooks.values()].find(
      (candidate) => candidate.name === 'agent-pulpit'
    )
    expect(webhook).toBeDefined()
    expect(webhook?.sent).toHaveLength(1)
    expect(webhook?.sent[0]?.username).toBe('cody')
    expect(webhook?.sent[0]?.avatar_url ?? webhook?.sent[0]?.avatarURL).toBe(
      'https://api.dicebear.com/7.x/bottts/png?seed=cody'
    )
    expect(webhook?.sent[0]?.content).toBe(
      '-# cody@agent-spaces:T-04321~main\n⏳ **Processing:** Please do the work'
    )
    expect(placeholder).toMatchObject({
      kind: 'message',
      id: webhook?.sent[0]?.message.id,
      channelId: channel.id,
      webhookId: webhook?.id,
      identity: {
        agentId: 'cody',
        subtext: 'cody@agent-spaces:T-04321~main',
        avatarUrl: 'https://api.dicebear.com/7.x/bottts/png?seed=cody',
      },
    })
  })

  test('finalizes webhook placeholders by editing via the same webhook identity', async () => {
    const channel = new FakeChannel('chan_placeholder_final')
    const webhook = await channel.createWebhook({ name: 'agent-pulpit' })
    const client = new FakeClient()
    client.addChannel(channel)

    const app = new GatewayDiscordApp({
      acpBaseUrl: 'http://acp.test',
      gatewayId: 'discord_prod',
      client: client as never,
      fetchImpl: createFetch(async () => Response.json({ bindings: [] })),
      maxChars: 80,
    })
    ;(
      app as unknown as {
        placeholdersByRunId: Map<string, unknown>
      }
    ).placeholdersByRunId.set('run_webhook_final', {
      ui: {
        gatewayId: 'discord_prod',
        kind: 'message',
        id: 'wh_placeholder_1',
        channelId: channel.id,
        webhookId: webhook.id,
      },
      identity: {
        agentId: 'cody',
        subtext: 'cody@agent-spaces:T-04321~main',
        avatarUrl: 'https://api.dicebear.com/7.x/bottts/png?seed=cody',
      },
    })

    const delivery: DeliveryRequest = {
      deliveryRequestId: 'dr_webhook_final',
      gatewayId: 'discord_prod',
      bindingId: 'ifb_webhook_final',
      sessionRef: {
        scopeRef: 'agent:cody:project:agent-spaces:task:T-04321',
        laneRef: 'main',
      },
      runId: 'run_webhook_final',
      conversationRef: `channel:${channel.id}`,
      body: {
        kind: 'text/markdown',
        text: `Final answer\n\n${'overflow '.repeat(30)}`,
      },
      status: 'queued',
      createdAt: '2026-05-06T14:00:00.000Z',
    }

    await (
      app as unknown as { deliverToDiscord(delivery: DeliveryRequest): Promise<void> }
    ).deliverToDiscord(delivery)

    expect(channel.sent).toHaveLength(0)
    expect(webhook.edits).toHaveLength(1)
    expect(webhook.edits[0]).toMatchObject({
      messageId: 'wh_placeholder_1',
      payload: {},
    })
    expect(webhook.edits[0]?.payload.username).toBeUndefined()
    expect(webhook.edits[0]?.payload.avatar_url).toBeUndefined()
    expect(webhook.edits[0]?.payload.avatarURL).toBeUndefined()
    expect(webhook.edits[0]?.payload.content).toContain(
      '-# cody@agent-spaces:T-04321~main\nFinal answer'
    )
    expect(webhook.sent.length).toBeGreaterThan(0)
    expect(webhook.sent.every((payload) => payload.username === 'cody')).toBe(true)
    expect(
      webhook.sent.every(
        (payload) =>
          (payload.avatar_url ?? payload.avatarURL) ===
          'https://api.dicebear.com/7.x/bottts/png?seed=cody'
      )
    ).toBe(true)
  })

  test('webhook placeholder without webhookId falls through to fresh webhook send (never Rex)', async () => {
    // Restart-fallback / legacy-state regression guard. If a placeholder entry
    // somehow has no `webhookId` (e.g. created by a pre-refactor process before
    // restart, or legacy/test entry), deliverToDiscord MUST NOT fall back to
    // `renderToDiscord` (bot/Rex). It must send the final via the agent
    // webhook so the visible identity stays correct.
    const channel = new FakeChannel('chan_no_webhook_id')
    await channel.createWebhook({ name: 'agent-pulpit' })
    const client = new FakeClient()
    client.addChannel(channel)

    const app = new GatewayDiscordApp({
      acpBaseUrl: 'http://acp.test',
      gatewayId: 'discord_prod',
      client: client as never,
      fetchImpl: createFetch(async () => Response.json({ bindings: [] })),
    })
    ;(
      app as unknown as {
        placeholdersByRunId: Map<string, unknown>
      }
    ).placeholdersByRunId.set('run_legacy_no_webhook', {
      ui: {
        gatewayId: 'discord_prod',
        kind: 'message',
        id: 'legacy_placeholder_msg',
        channelId: channel.id,
        // webhookId intentionally omitted
      },
      // identity intentionally omitted; deliverToDiscord must derive from sessionRef
    })

    const delivery: DeliveryRequest = {
      deliveryRequestId: 'dr_legacy_no_webhook',
      gatewayId: 'discord_prod',
      bindingId: 'ifb_legacy',
      sessionRef: {
        scopeRef: 'agent:cody:project:agent-spaces:task:T-04321',
        laneRef: 'main',
      },
      runId: 'run_legacy_no_webhook',
      conversationRef: `channel:${channel.id}`,
      body: { kind: 'text/markdown', text: 'Legacy fallback final.' },
      status: 'queued',
      createdAt: '2026-05-06T15:00:00.000Z',
    }

    await (
      app as unknown as { deliverToDiscord(delivery: DeliveryRequest): Promise<void> }
    ).deliverToDiscord(delivery)

    // Bot path must not be used — channel.sent contains no agent finals.
    expect(channel.sent).toHaveLength(0)

    // Fresh webhook send must have happened with cody identity + subtext.
    const webhook = [...channel.webhooks.values()].find((w) => w.name === 'agent-pulpit')
    expect(webhook).toBeDefined()
    expect(webhook?.sent).toHaveLength(1)
    expect(webhook?.sent[0]?.content).toContain('-# cody@agent-spaces:T-04321~main\n')
    expect(webhook?.sent[0]?.content).toContain('Legacy fallback final.')
    expect(webhook?.sent[0]?.username).toBe('cody')
  })

  test('agent webhook chunks never exceed maxChars even with subtext prefix', async () => {
    // Smoke issue 4 regression guard: the `-# {subtext}\n` prefix must be
    // budgeted into the chunk size. Previously, a body at exactly maxChars
    // produced a first chunk of `2000 + prefix.length` and Discord rejected
    // it with BASE_TYPE_MAX_LENGTH.
    const channel = new FakeChannel('chan_chunk_budget')
    await channel.createWebhook({ name: 'agent-pulpit' })
    const client = new FakeClient()
    client.addChannel(channel)

    const maxChars = 100
    const app = new GatewayDiscordApp({
      acpBaseUrl: 'http://acp.test',
      gatewayId: 'discord_prod',
      client: client as never,
      fetchImpl: createFetch(async () => Response.json({ bindings: [] })),
      maxChars,
    })

    // Body sized so that subtext + body would push the first chunk over
    // maxChars unless the prefix is budgeted in.
    const longBody = 'x '.repeat(150)
    const delivery: DeliveryRequest = {
      deliveryRequestId: 'dr_chunk_budget',
      gatewayId: 'discord_prod',
      bindingId: 'ifb_chunk_budget',
      sessionRef: {
        scopeRef: 'agent:cody:project:agent-spaces:task:T-04321',
        laneRef: 'main',
      },
      conversationRef: `channel:${channel.id}`,
      body: { kind: 'text/markdown', text: longBody },
      status: 'queued',
      createdAt: '2026-05-06T15:00:00.000Z',
    }

    await (
      app as unknown as { deliverToDiscord(delivery: DeliveryRequest): Promise<void> }
    ).deliverToDiscord(delivery)

    const webhook = [...channel.webhooks.values()].find((w) => w.name === 'agent-pulpit')
    expect(webhook).toBeDefined()
    expect(webhook?.sent.length).toBeGreaterThan(1)
    for (const sent of webhook?.sent ?? []) {
      expect(sent.content.length).toBeLessThanOrEqual(maxChars)
    }
  })

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
      const client = new FakeClient()
      client.addChannel(channel)

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
