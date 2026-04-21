import { describe, expect, test } from 'bun:test'

import type { DeliveryRequest } from 'acp-core'

import { withWiredServer } from '../../../acp-server/test/fixtures/wired-server.js'
import { GatewayDiscordApp } from '../app.js'

class FakeSentMessage {
  constructor(
    readonly id: string,
    readonly channelId: string,
    public content: string
  ) {}

  readonly edits: string[] = []
  readonly replies: string[] = []
  deleted = false

  async edit(input: { content: string }): Promise<this> {
    this.content = input.content
    this.edits.push(input.content)
    return this
  }

  async delete(): Promise<void> {
    this.deleted = true
  }
}

class FakeChannel {
  readonly sent: Array<{
    content: string
    replyTo?: string | undefined
    message: FakeSentMessage
  }> = []
  readonly messages = {
    fetch: async (id: string) => this.messageById.get(id) ?? null,
  }

  private nextId = 1
  private readonly messageById = new Map<string, FakeSentMessage>()

  constructor(readonly id: string) {}

  isTextBased(): true {
    return true
  }

  async send(
    input: string | { content: string; reply?: { messageReference: string } }
  ): Promise<FakeSentMessage> {
    const content = typeof input === 'string' ? input : input.content
    const replyTo = typeof input === 'string' ? undefined : input.reply?.messageReference
    const message = new FakeSentMessage(`m${this.nextId++}`, this.id, content)
    this.sent.push({ content, replyTo, message })
    this.messageById.set(message.id, message)
    return message
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

describe('GatewayDiscordApp local e2e', () => {
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

      expect(threadChannel.sent).toHaveLength(1)
      expect(threadChannel.sent[0]?.content).toContain('⏳ **Processing:**')

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

      expect(threadChannel.sent).toHaveLength(1)
      expect(threadChannel.sent[0]?.message.edits.at(-1)).toContain('Final answer')
      expect(fixture.interfaceStore.deliveries.get('dr_123')?.status).toBe('delivered')
    })
  })

  test('sends a fresh Discord reply when no placeholder exists', async () => {
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

      expect(channel.sent).toHaveLength(1)
      expect(channel.sent[0]?.content).toContain('Fresh reply')
      expect(channel.sent[0]?.replyTo).toBe('orig_1')
      expect(fixture.interfaceStore.deliveries.get('dr_234')?.status).toBe('delivered')
    })
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

      // Placeholder was sent once (the `⏳ Processing` frame).
      expect(channel.sent).toHaveLength(1)
      const placeholderMessage = channel.sent[0]?.message
      expect(placeholderMessage).toBeDefined()
      // And it was edited in place to a visible `⚠️` failure — not deleted, not orphaned.
      expect(placeholderMessage?.deleted).toBe(false)
      expect(placeholderMessage?.edits).toHaveLength(1)
      expect(placeholderMessage?.content).toContain('⚠️')
      expect(placeholderMessage?.content).toContain('Could not reach ACP')
      expect(placeholderMessage?.content).toContain('ECONNREFUSED')
    })
  })
})
