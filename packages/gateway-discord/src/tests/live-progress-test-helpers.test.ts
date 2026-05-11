import { expect } from 'bun:test'

import { GatewayDiscordApp } from '../app.js'

type FakeDiscordFile = {
  name?: string | undefined
  description?: string | null | undefined
}

export type FakeSendPayload = {
  content: string
  reply?: { messageReference: string } | undefined
  files?: FakeDiscordFile[] | undefined
  username?: string | undefined
  avatarURL?: string | undefined
  avatar_url?: string | undefined
}

export class FakeSentMessage {
  readonly edits: FakeSendPayload[] = []
  deleted = false

  constructor(
    readonly id: string,
    readonly channelId: string,
    public content: string
  ) {}

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

export class FakeWebhook {
  readonly sent: Array<FakeSendPayload & { message: FakeSentMessage }> = []
  readonly edits: Array<{ messageId: string; payload: FakeSendPayload }> = []
  readonly failedEdits: Array<{ messageId: string; payload: FakeSendPayload; error: unknown }> = []
  failNextEditWith: unknown | undefined
  private nextId = 1

  constructor(
    readonly id: string,
    readonly token: string,
    readonly name: string,
    readonly channelId: string
  ) {}

  async send(input: string | FakeSendPayload): Promise<FakeSentMessage> {
    const payload = typeof input === 'string' ? { content: input } : input
    const message = new FakeSentMessage(`wh_${this.nextId++}`, this.channelId, payload.content)
    this.sent.push({ ...payload, message })
    return message
  }

  async editMessage(messageId: string, input: string | FakeSendPayload): Promise<FakeSentMessage> {
    const payload = typeof input === 'string' ? { content: input } : input
    if (this.failNextEditWith !== undefined) {
      const error = this.failNextEditWith
      this.failNextEditWith = undefined
      this.failedEdits.push({ messageId, payload, error })
      throw error
    }

    this.edits.push({ messageId, payload })
    return new FakeSentMessage(messageId, this.channelId, payload.content)
  }
}

export class FakeChannel {
  readonly sent: Array<FakeSendPayload & { message: FakeSentMessage }> = []
  readonly webhooks = new Map<string, FakeWebhook>()
  readonly messages = {
    fetch: async (id: string) => this.messageById.get(id) ?? null,
  }
  readonly typingPings: number[] = []

  private nextId = 1
  private readonly messageById = new Map<string, FakeSentMessage>()

  constructor(readonly id: string) {}

  isTextBased(): true {
    return true
  }

  isThread(): false {
    return false
  }

  async sendTyping(): Promise<void> {
    this.typingPings.push(Date.now())
  }

  async send(input: string | FakeSendPayload): Promise<FakeSentMessage> {
    const payload = typeof input === 'string' ? { content: input } : input
    const message = new FakeSentMessage(`m${this.nextId++}`, this.id, payload.content)
    this.sent.push({ ...payload, message })
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

export class FakeClient {
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

export type LiveProgressHarness = {
  app: GatewayDiscordApp
  channel: FakeChannel
  client: FakeClient
  eventRequests: URL[]
  emit: (event: Record<string, unknown>) => void
  closeEvents: () => void
  enqueueDelivery: (text: string) => void
  inboundMessage: () => never
  webhook: () => FakeWebhook
}

const encoder = new TextEncoder()

export function createRateLimitError(): Error & { status: number; retryAfter: number } {
  const error = new Error('rate limited') as Error & { status: number; retryAfter: number }
  error.status = 429
  error.retryAfter = 0
  return error
}

export function createLiveProgressHarness(
  options: {
    interfaceMessageResponse?: (ingressCount: number) => Record<string, unknown>
  } = {}
): LiveProgressHarness {
  const channel = new FakeChannel('chan_live_progress')
  const client = new FakeClient()
  client.addChannel(channel)

  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined
  const pendingEvents: string[] = []
  const deliveries: unknown[] = []
  const eventRequests: URL[] = []
  let ingressCount = 0

  const enqueue = (line: string) => {
    if (streamController) {
      streamController.enqueue(encoder.encode(line))
    } else {
      pendingEvents.push(line)
    }
  }

  const fetchImpl = async (
    input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(String(input), init)
    const url = new URL(request.url)

    if (url.pathname === '/v1/interface/bindings') {
      return Response.json({
        bindings: [
          {
            bindingId: 'ifb_live_progress',
            gatewayId: 'discord_prod',
            conversationRef: 'channel:chan_live_progress',
            scopeRef: 'agent:smokey:project:agent-spaces',
            laneRef: 'main',
            sessionRef: {
              scopeRef: 'agent:smokey:project:agent-spaces',
              laneRef: 'main',
            },
            projectId: 'agent-spaces',
            status: 'active',
            createdAt: '2026-05-06T19:00:00.000Z',
            updatedAt: '2026-05-06T19:00:00.000Z',
          },
        ],
      })
    }

    if (url.pathname === '/v1/interface/messages') {
      expect(request.method).toBe('POST')
      ingressCount += 1
      return Response.json(
        options.interfaceMessageResponse?.(ingressCount) ?? {
          inputAttemptId: 'ia_live_progress',
          runId: ingressCount === 1 ? 'run_live_progress' : `run_live_progress_${ingressCount}`,
          hostSessionId: 'hsid_live_progress',
          generation: 7,
        },
        { status: 201 }
      )
    }

    if (url.pathname.startsWith('/v1/runs/')) {
      const runId = decodeURIComponent(url.pathname.slice('/v1/runs/'.length))
      const hrcRunId =
        runId === 'run_live_progress'
          ? 'hrc_run_live_progress'
          : `hrc_${runId.replace(/^run_/, 'run_')}`

      if (runId === 'run_queued_future') {
        return Response.json({
          run: {
            runId,
            status: 'queued',
            hrcRunId: null,
            hostSessionId: 'hsid_live_progress',
            runtimeId: null,
            generation: 7,
          },
          queue: { status: 'queued', seq: 1 },
        })
      }

      return Response.json({
        run: {
          runId,
          status: 'running',
          hrcRunId,
          hostSessionId: 'hsid_live_progress',
          runtimeId: 'rt_live_progress',
          generation: 7,
        },
      })
    }

    if (url.pathname === '/v1/session-refs/events') {
      eventRequests.push(url)
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller
          while (pendingEvents.length > 0) {
            const pending = pendingEvents.shift()
            if (pending !== undefined) {
              controller.enqueue(encoder.encode(pending))
            }
          }
        },
        cancel() {
          streamController = undefined
        },
      })
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'application/x-ndjson' },
      })
    }

    if (url.pathname === '/v1/gateway/discord_prod/deliveries/stream') {
      const drained = deliveries.splice(0)
      return Response.json({ deliveries: drained, nextCursor: null })
    }

    if (url.pathname === '/v1/gateway/deliveries/dr_live_progress/ack') {
      return Response.json({})
    }

    if (url.pathname === '/v1/gateway/deliveries/dr_live_progress/fail') {
      return Response.json({})
    }

    return new Response('not found', { status: 404 })
  }

  const app = new GatewayDiscordApp({
    acpBaseUrl: 'http://acp.test',
    gatewayId: 'discord_prod',
    client: client as never,
    fetchImpl,
  })

  return {
    app,
    channel,
    client,
    eventRequests,
    emit: (event) => enqueue(`${JSON.stringify(event)}\n`),
    closeEvents: () => {
      streamController?.close()
      streamController = undefined
    },
    enqueueDelivery: (text) => {
      deliveries.push(finalDeliveryBody(text))
    },
    inboundMessage: () =>
      ({
        guildId: 'guild_1',
        author: { id: 'user_1', bot: false },
        content: 'render live tool progress',
        attachments: { size: 0 },
        channelId: 'chan_live_progress',
        id: 'msg_live_progress',
        channel: {
          isThread: () => false,
        },
        reply: async () => undefined,
      }) as never,
    webhook: () => {
      const webhook = [...channel.webhooks.values()].find((item) => item.name === 'agent-pulpit')
      expect(webhook).toBeDefined()
      return webhook as FakeWebhook
    },
  }
}

export function hrcEvent(seq: number, payload: Record<string, unknown>): Record<string, unknown> {
  return {
    hrcSeq: seq,
    streamSeq: seq,
    ts: new Date(Date.now() + seq * 1000).toISOString(),
    hostSessionId: 'hsid_live_progress',
    scopeRef: 'agent:smokey:project:agent-spaces',
    laneRef: 'main',
    generation: 7,
    runtimeId: 'rt_live_progress',
    runId: 'hrc_run_live_progress',
    category: 'turn',
    eventKind: String(payload['type'] ?? 'unknown'),
    replayed: false,
    payload,
  }
}

export function toolStart(
  seq: number,
  toolUseId: string,
  toolName: string,
  input: Record<string, unknown>
): Record<string, unknown> {
  return hrcEvent(seq, {
    type: 'tool_execution_start',
    toolUseId,
    toolName,
    input,
  })
}

export function toolEnd(seq: number, toolUseId: string, toolName: string): Record<string, unknown> {
  return hrcEvent(seq, {
    type: 'tool_execution_end',
    toolUseId,
    toolName,
    result: { content: [{ type: 'text', text: 'ok' }] },
  })
}

export function finalDeliveryBody(text: string) {
  return {
    deliveryRequestId: 'dr_live_progress',
    gatewayId: 'discord_prod',
    bindingId: 'ifb_live_progress',
    sessionRef: {
      scopeRef: 'agent:smokey:project:agent-spaces',
      laneRef: 'main',
    },
    scopeRef: 'agent:smokey:project:agent-spaces',
    laneRef: 'main',
    runId: 'run_live_progress',
    conversationRef: 'channel:chan_live_progress',
    replyToMessageRef: 'discord:message:msg_live_progress',
    body: {
      kind: 'text/markdown',
      text,
    },
    bodyKind: 'text/markdown',
    bodyText: text,
    createdAt: '2026-05-06T19:01:00.000Z',
  }
}

export async function waitFor(predicate: () => boolean, timeoutMs = 250): Promise<void> {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
