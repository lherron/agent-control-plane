import { randomUUID } from 'node:crypto'

import type { DeliveryRequest } from 'acp-core'
import { Client, Events, GatewayIntentBits, type Message } from 'discord.js'

import { mapDiscordMessageAttachments, resolveDiscordIngressContent } from './attachment-ingress.js'
import { createDiscordAttachments, fetchMediaAttachments } from './attachments.js'
import {
  BindingIndex,
  conversationRefToChannelId,
  threadRefToThreadId,
  toConversationRefs,
} from './bindings.js'
import {
  DEFAULT_BINDINGS_REFRESH_MS,
  DEFAULT_DELIVERY_IDLE_MS,
  DEFAULT_DELIVERY_POLL_MS,
  DEFAULT_MAX_CHARS,
  envNumber,
  optionalEnv,
  requiredEnv,
} from './config.js'
import { classifyDiscordError } from './discord-errors.js'
import { renderToDiscord } from './discord-render.js'
import { createLogger } from './logger.js'
import {
  type RenderOptions,
  extractImagesFromFrame,
  extractMediaRefsFromFrame,
  renderFrameToDiscordContent,
  splitIntoChunks,
} from './render.js'
import type {
  DeliveryStreamResponse,
  DiscordInterfaceBinding,
  RenderBlock,
  RenderFrame,
  UiHandle,
} from './types.js'

const VIRTU_BOT_ID = optionalEnv('DISCORD_VIRTU_BOT_ID') ?? '1165644636807778414'

type FetchLike = typeof fetch

type PendingPlaceholder = {
  ui: UiHandle & { kind: 'message' }
}

export type GatewayDiscordAppOptions = {
  acpBaseUrl: string
  gatewayId: string
  discordToken?: string | undefined
  client?: Client | undefined
  fetchImpl?: FetchLike | undefined
  maxChars?: number | undefined
  renderOptions?: RenderOptions | undefined
  bindingsRefreshMs?: number | undefined
  deliveryPollMs?: number | undefined
  deliveryIdleMs?: number | undefined
}

export const log = createLogger({ component: 'gateway-discord' })

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
}

function parseDiscordMessageRef(value: string | undefined): string | undefined {
  if (!value) {
    return undefined
  }

  const parts = value.split(':')
  return parts.length > 0 ? parts[parts.length - 1] : undefined
}

function buildFinalFrame(
  delivery: DeliveryRequest,
  binding?: DiscordInterfaceBinding
): RenderFrame {
  const blocks: RenderBlock[] = [{ t: 'markdown', md: delivery.body.text }]

  // Convert delivery attachments into media_ref render blocks
  if (delivery.body.attachments) {
    for (const attachment of delivery.body.attachments) {
      const url = attachment.url ?? attachment.path
      if (!url) continue
      blocks.push({
        t: 'media_ref',
        url,
        ...(attachment.contentType ? { mimeType: attachment.contentType } : {}),
        ...(attachment.filename ? { filename: attachment.filename } : {}),
        ...(attachment.alt ? { alt: attachment.alt } : {}),
      })
    }
  }

  return {
    runId: delivery.runId ?? delivery.deliveryRequestId,
    projectId: binding?.projectId ?? delivery.sessionRef.scopeRef,
    phase: 'final',
    blocks,
    updatedAt: Date.now(),
  }
}

function isSendableChannel(
  channel: Awaited<ReturnType<Client['channels']['fetch']>>
): channel is Awaited<ReturnType<Client['channels']['fetch']>> & {
  send: (options: unknown) => Promise<{ id: string; channelId: string }>
  isTextBased(): true
} {
  return Boolean(channel?.isTextBased() && 'send' in channel)
}

export class GatewayDiscordApp {
  private readonly acpBaseUrl: string
  private readonly gatewayId: string
  private readonly client: Client
  private readonly fetchImpl: FetchLike
  private readonly maxChars: number
  private readonly renderOptions: RenderOptions
  private readonly bindingsRefreshMs: number
  private readonly deliveryPollMs: number
  private readonly deliveryIdleMs: number
  private readonly discordToken?: string | undefined
  private readonly bindings = new BindingIndex()
  private readonly placeholdersByRunId = new Map<string, PendingPlaceholder>()
  private readonly createdClient: boolean
  private readonly onMessageCreateBound: (message: Message) => Promise<void>

  private bindingsTimer: ReturnType<typeof setInterval> | undefined
  private deliveryLoopPromise: Promise<void> | undefined
  private deliveryLoopStopped = false
  private deliveryCursor: string | undefined

  constructor(options: GatewayDiscordAppOptions) {
    this.acpBaseUrl = normalizeBaseUrl(options.acpBaseUrl)
    this.gatewayId = options.gatewayId
    this.client =
      options.client ??
      new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.MessageContent,
        ],
      })
    this.fetchImpl = options.fetchImpl ?? fetch
    this.maxChars = options.maxChars ?? DEFAULT_MAX_CHARS
    this.renderOptions = options.renderOptions ?? {
      useBlockQuotes: process.env['ACP_DISCORD_USE_BLOCKQUOTES'] === '1',
    }
    this.bindingsRefreshMs = options.bindingsRefreshMs ?? DEFAULT_BINDINGS_REFRESH_MS
    this.deliveryPollMs = options.deliveryPollMs ?? DEFAULT_DELIVERY_POLL_MS
    this.deliveryIdleMs = options.deliveryIdleMs ?? DEFAULT_DELIVERY_IDLE_MS
    this.discordToken = options.discordToken
    this.createdClient = options.client === undefined
    this.onMessageCreateBound = async (message) => {
      try {
        await this.handleMessageCreate(message)
      } catch (error) {
        log.error('gw.messageCreate.failed', {
          message: 'handleMessageCreate threw; keeping gateway alive',
          trace: { gatewayId: this.gatewayId },
          err: { message: error instanceof Error ? error.message : String(error) },
        })
      }
    }
  }

  async start(): Promise<void> {
    await this.refreshBindings()
    this.client.on(Events.MessageCreate, this.onMessageCreateBound)

    if (this.createdClient) {
      this.client.once(Events.ClientReady, () => {
        log.info('gw.ready', {
          message: `Discord ready as ${this.client.user?.tag ?? 'unknown'}`,
          trace: { gatewayId: this.gatewayId },
          data: { discordUserTag: this.client.user?.tag },
        })
      })

      const token = this.discordToken ?? requiredEnv('DISCORD_TOKEN', 'DISCORD_BLASTER_TOKEN')
      await this.client.login(token)
    }

    this.bindingsTimer = setInterval(() => {
      void this.refreshBindings().catch((error) => {
        log.warn('gw.bindings.refresh_failed', {
          message: 'Failed to refresh bindings',
          trace: { gatewayId: this.gatewayId },
          err: { message: error instanceof Error ? error.message : String(error) },
        })
      })
    }, this.bindingsRefreshMs)

    this.deliveryLoopStopped = false
    this.deliveryLoopPromise = this.runDeliveryLoop()
  }

  async stop(): Promise<void> {
    this.deliveryLoopStopped = true
    if (this.bindingsTimer) {
      clearInterval(this.bindingsTimer)
      this.bindingsTimer = undefined
    }

    if (this.deliveryLoopPromise) {
      await this.deliveryLoopPromise
      this.deliveryLoopPromise = undefined
    }

    this.client.off(Events.MessageCreate, this.onMessageCreateBound)
    if (this.createdClient) {
      this.client.destroy()
    }
  }

  async refreshBindings(): Promise<DiscordInterfaceBinding[]> {
    const payload = await this.fetchJson<{ bindings: DiscordInterfaceBinding[] }>(
      `/v1/interface/bindings?gatewayId=${encodeURIComponent(this.gatewayId)}`
    )
    this.bindings.replaceAll(payload.bindings)
    return payload.bindings
  }

  async pollDeliveriesOnce(): Promise<number> {
    const query = this.deliveryCursor ? `?since=${encodeURIComponent(this.deliveryCursor)}` : ''
    const payload = await this.fetchJson<DeliveryStreamResponse>(
      `/v1/gateway/${encodeURIComponent(this.gatewayId)}/deliveries/stream${query}`
    )

    if (payload.nextCursor) {
      this.deliveryCursor = payload.nextCursor
    }

    for (const delivery of payload.deliveries) {
      await this.processDelivery(delivery)
    }

    return payload.deliveries.length
  }

  async handleMessageCreate(message: Message): Promise<void> {
    if (!message.guildId) {
      return
    }

    if (message.author.bot) {
      if (message.author.id === VIRTU_BOT_ID) {
        // test bot allowed through
      } else if (message.author.id === this.client.user?.id) {
        return
      } else {
        return
      }
    }

    const conversation = toConversationRefs({
      channelId: message.channel.isThread()
        ? (message.channel.parentId ?? message.channelId)
        : message.channelId,
      ...(message.channel.isThread() ? { threadId: message.channelId } : {}),
    })

    let binding = this.bindings.getBindingFor(conversation)
    if (!binding) {
      await this.refreshBindings()
      binding = this.bindings.getBindingFor(conversation)
    }

    if (!binding) {
      await message.reply(
        'No project is bound to this channel/thread. Use ACP interface bindings to create one.'
      )
      return
    }

    const placeholder = await this.createPlaceholder(message)
    const content = resolveDiscordIngressContent(message)
    const attachments = mapDiscordMessageAttachments(message)
    let response: Response
    try {
      response = await this.fetchImpl(`${this.acpBaseUrl}/v1/interface/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          idempotencyKey: `discord:message:${message.id}`,
          source: {
            gatewayId: this.gatewayId,
            conversationRef: conversation.conversationRef,
            ...(conversation.threadRef ? { threadRef: conversation.threadRef } : {}),
            messageRef: `discord:message:${message.id}`,
            authorRef: `discord:user:${message.author.id}`,
          },
          content,
          ...(attachments.length > 0 ? { attachments } : {}),
        }),
      })
    } catch (error) {
      // Thrown fetch (network error, socket refused, timeout) never reaches the
      // `!response.ok` branch, so the placeholder would otherwise stay as a
      // stale `⏳ Processing` forever. Replace it with a visible error frame so
      // the user sees the failure at the same location they were watching.
      const reason = error instanceof Error ? error.message : String(error)
      if (placeholder) {
        await this.failPlaceholder(placeholder, `Could not reach ACP: ${reason}`)
      }
      throw error
    }

    if (!response.ok) {
      if (placeholder) {
        await this.deletePlaceholder(placeholder)
      }
      throw new Error(`Interface ingress failed: ${response.status} ${await response.text()}`)
    }

    const payload = (await response.json()) as { inputAttemptId: string; runId: string }
    if (placeholder) {
      this.placeholdersByRunId.set(payload.runId, {
        ui: placeholder,
      })
    }
  }

  private async runDeliveryLoop(): Promise<void> {
    while (!this.deliveryLoopStopped) {
      try {
        const count = await this.pollDeliveriesOnce()
        await sleep(count > 0 ? this.deliveryPollMs : this.deliveryIdleMs)
      } catch (error) {
        log.error('gw.deliveries.loop_error', {
          message: 'Delivery loop iteration failed',
          trace: { gatewayId: this.gatewayId },
          err: { message: error instanceof Error ? error.message : String(error) },
        })
        await sleep(this.deliveryIdleMs)
      }
    }
  }

  private async processDelivery(delivery: DeliveryRequest): Promise<void> {
    try {
      await this.deliverToDiscord(delivery)
      await this.postJson(`/v1/gateway/deliveries/${delivery.deliveryRequestId}/ack`, {})
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.postJson(`/v1/gateway/deliveries/${delivery.deliveryRequestId}/fail`, {
        code: 'discord_delivery_failed',
        message,
      })
      throw error
    }
  }

  private async deliverToDiscord(delivery: DeliveryRequest): Promise<void> {
    const binding = this.bindings.getBindingFor({
      conversationRef: delivery.conversationRef,
      ...(delivery.threadRef ? { threadRef: delivery.threadRef } : {}),
    })
    const frame = buildFinalFrame(delivery, binding)
    const placeholder = delivery.runId ? this.placeholdersByRunId.get(delivery.runId) : undefined

    if (placeholder) {
      try {
        await renderToDiscord(this.client, placeholder.ui, frame, this.maxChars, this.renderOptions)
      } finally {
        if (delivery.runId) {
          this.placeholdersByRunId.delete(delivery.runId)
        }
      }
      return
    }

    const targetChannelId =
      threadRefToThreadId(delivery.threadRef) ??
      conversationRefToChannelId(delivery.conversationRef)
    if (!targetChannelId) {
      throw new Error(`Unsupported Discord conversationRef: ${delivery.conversationRef}`)
    }
    const channel = await this.client.channels.fetch(targetChannelId)
    if (!isSendableChannel(channel)) {
      throw new Error(`Discord target channel is not sendable: ${targetChannelId}`)
    }

    const content = renderFrameToDiscordContent(frame, this.maxChars)
    const chunks = splitIntoChunks(content, this.maxChars, this.renderOptions)
    const replyToMessageId = parseDiscordMessageRef(delivery.replyToMessageRef)

    // Extract image and media attachments from the frame
    const imageAttachments = extractImagesFromFrame(frame)
    const mediaRefs = extractMediaRefsFromFrame(frame)
    const mediaFiles = await fetchMediaAttachments(mediaRefs, undefined)
    const discordFiles = [...createDiscordAttachments(imageAttachments), ...mediaFiles]
    const filesPayload = discordFiles.length > 0 ? { files: discordFiles } : {}

    for (let index = 0; index < chunks.length; index += 1) {
      const isLastChunk = index === chunks.length - 1
      const chunkFiles = isLastChunk ? filesPayload : {}
      try {
        await channel.send({
          content: chunks[index],
          ...(index === 0 && replyToMessageId
            ? {
                reply: {
                  messageReference: replyToMessageId,
                },
              }
            : {}),
          ...chunkFiles,
        })
      } catch (error) {
        classifyDiscordError(error, 'send', { channelId: targetChannelId })
        throw error
      }
    }
  }

  private async createPlaceholder(
    message: Message
  ): Promise<(UiHandle & { kind: 'message' }) | undefined> {
    try {
      const channel = await this.client.channels.fetch(message.channelId)
      if (!isSendableChannel(channel)) {
        return undefined
      }

      const promptPreview =
        message.content.length > 100 ? `${message.content.slice(0, 100)}…` : message.content
      const initialMessage = await channel.send(`⏳ **Processing:** ${promptPreview}`)

      return {
        gatewayId: this.gatewayId,
        kind: 'message',
        id: initialMessage.id,
        channelId: initialMessage.channelId,
        ...(message.channel.isThread() ? { threadId: message.channelId } : {}),
      }
    } catch (error) {
      log.warn('gw.discord.placeholder.failed', {
        message: 'Failed to send placeholder',
        trace: { gatewayId: this.gatewayId },
        data: { channelId: message.channelId },
        err: { message: error instanceof Error ? error.message : String(error) },
      })
      return undefined
    }
  }

  private async deletePlaceholder(ui: UiHandle & { kind: 'message' }): Promise<void> {
    if (!ui.channelId) {
      return
    }

    try {
      const channel = await this.client.channels.fetch(ui.channelId)
      if (!channel || !channel.isTextBased() || !('messages' in channel)) {
        return
      }
      const message = await channel.messages.fetch(ui.id)
      if (message) {
        await message.delete()
      }
    } catch {
      // best-effort cleanup only
    }
  }

  /**
   * Replace a `⏳ Processing` placeholder in-place with a visible `⚠️` failure
   * notice. Used when ACP ingress fails with a thrown exception (the
   * `!response.ok` branch already handles HTTP errors via `deletePlaceholder`).
   */
  private async failPlaceholder(ui: UiHandle & { kind: 'message' }, reason: string): Promise<void> {
    if (!ui.channelId) {
      return
    }

    try {
      const channel = await this.client.channels.fetch(ui.channelId)
      if (!channel || !channel.isTextBased() || !('messages' in channel)) {
        return
      }
      const message = await channel.messages.fetch(ui.id)
      if (message) {
        await message.edit({ content: `⚠️ ${reason}` })
      }
    } catch {
      // best-effort cleanup only
    }
  }

  private async fetchJson<T>(path: string): Promise<T> {
    const response = await this.fetchImpl(`${this.acpBaseUrl}${path}`)
    if (!response.ok) {
      throw new Error(`Request failed: ${response.status} ${await response.text()}`)
    }
    return (await response.json()) as T
  }

  private async postJson(path: string, body: unknown): Promise<void> {
    const response = await this.fetchImpl(`${this.acpBaseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      throw new Error(`Request failed: ${response.status} ${await response.text()}`)
    }
  }
}

export async function startGateway(): Promise<void> {
  const app = new GatewayDiscordApp({
    acpBaseUrl: requiredEnv('ACP_BASE_URL', 'CP_URL'),
    gatewayId:
      optionalEnv('ACP_GATEWAY_ID', 'CP_GATEWAY_ID') ?? `discord-${randomUUID().slice(0, 8)}`,
    maxChars: envNumber(['ACP_DISCORD_MAX_CHARS', 'CP_DISCORD_MAX_CHARS'], DEFAULT_MAX_CHARS),
    bindingsRefreshMs: envNumber(
      ['ACP_BINDINGS_REFRESH_MS', 'CP_BINDINGS_REFRESH_MS'],
      DEFAULT_BINDINGS_REFRESH_MS
    ),
    deliveryPollMs: envNumber(
      ['ACP_DELIVERY_POLL_MS', 'CP_DELIVERY_POLL_MS'],
      DEFAULT_DELIVERY_POLL_MS
    ),
    deliveryIdleMs: envNumber(
      ['ACP_DELIVERY_IDLE_MS', 'CP_DELIVERY_IDLE_MS'],
      DEFAULT_DELIVERY_IDLE_MS
    ),
  })

  await app.start()
}
