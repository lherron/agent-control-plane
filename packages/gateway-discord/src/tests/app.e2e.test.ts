import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

class FakeChannel {
  readonly sent: Array<
    FakeSendPayload & { replyTo?: string | undefined; message: FakeSentMessage }
  > = []
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
      expect(threadChannel.sent[0]?.message.edits.at(-1)?.content).toContain('Final answer')
      expect(fixture.interfaceStore.deliveries.get('dr_123')?.status).toBe('delivered')
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

          expect(channel.sent[0]?.content).toContain('⏳ **Processing:**')
          expect(launches).toHaveLength(1)
          expect(launches[0]?.intent.initialPrompt).toBe('<media:image> (1 image)')

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
            bundle: { kind: 'agent-default' },
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

  test('sends delivery body attachments as Discord files on a fresh reply', async () => {
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

      expect(channel.sent).toHaveLength(1)
      expect(channel.sent[0]?.content).toContain('Here is the generated image.')
      expect(channel.sent[0]?.replyTo).toBe('origin')
      expect(channel.sent[0]?.files?.map((file) => file.name)).toEqual(['generated.png'])
      expect(channel.sent[0]?.files?.[0]?.description).toBe('Generated image alt text')
    } finally {
      globalThis.fetch = priorFetch
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
