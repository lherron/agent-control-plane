import { httpErrorField } from './discord-errors.js'
import { createLogger } from './logger.js'

export type WebhookPayload = {
  content: string
  username?: string | undefined
  avatar_url?: string | undefined
  avatarURL?: string | undefined
  webhookAvatar?: WebhookAvatarOverride | undefined
  files?: unknown[] | undefined
  components?: unknown[] | undefined
}

export type WebhookAvatarOverride = {
  key: string
  data: Buffer
}

export type WebhookMessage = {
  id: string
}

type DiscordWebhookSendPayload = Omit<
  WebhookPayload,
  'avatar_url' | 'avatarURL' | 'webhookAvatar'
> & {
  avatarURL?: string | undefined
  threadId?: string | undefined
}

type DiscordWebhookEditPayload = Omit<
  WebhookPayload,
  'avatar_url' | 'avatarURL' | 'username' | 'webhookAvatar'
> & {
  threadId?: string | undefined
}

type WebhookCollection =
  | Iterable<ManagedWebhook>
  | {
      values(): Iterable<ManagedWebhook>
    }

export type ManagedWebhook = {
  id: string
  token?: string | null | undefined
  name?: string | null | undefined
  edit?(options: { avatar?: Buffer | string | null | undefined }): Promise<ManagedWebhook>
  send(payload: DiscordWebhookSendPayload): Promise<WebhookMessage>
  editMessage(messageId: string, payload: DiscordWebhookEditPayload): Promise<WebhookMessage>
}

export type WebhookChannel = {
  isTextBased(): boolean
  fetchWebhooks?(): Promise<WebhookCollection>
  createWebhook?(options: { name: string }): Promise<ManagedWebhook>
  isThread?(): boolean
  parentId?: string | null
}

export type WebhookClientLike = {
  channels: {
    fetch(channelId: string): Promise<WebhookChannel | null>
  }
}

export type WebhookManagerOptions = {
  client: WebhookClientLike
  webhookName?: string | undefined
  sleep?: ((ms: number) => Promise<void>) | undefined
}

export type WebhookManager = {
  getOrCreateWebhook(channelId: string): Promise<ManagedWebhook>
  send(channelId: string, payload: WebhookPayload): Promise<WebhookMessage>
  editMessage(
    channelId: string,
    messageId: string,
    webhookId: string,
    payload: WebhookPayload
  ): Promise<WebhookMessage>
  editMessage(
    channelId: string,
    messageId: string,
    payload: WebhookPayload
  ): Promise<WebhookMessage>
  editMessageOnce(
    channelId: string,
    messageId: string,
    webhookId: string,
    payload: WebhookPayload
  ): Promise<WebhookMessage>
}

const DEFAULT_WEBHOOK_NAME = 'agent-pulpit'
const log = createLogger({ component: 'gateway-discord' })

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function webhookValues(collection: WebhookCollection): Iterable<ManagedWebhook> {
  if ('values' in collection && typeof collection.values === 'function') {
    return collection.values()
  }
  return collection as Iterable<ManagedWebhook>
}

function normalizeSendPayload(payload: WebhookPayload): DiscordWebhookSendPayload {
  const { avatar_url: avatarUrl, avatarURL, webhookAvatar: _webhookAvatar, ...rest } = payload
  const normalized: DiscordWebhookSendPayload = { ...rest }
  const resolvedAvatarURL = avatarURL ?? avatarUrl
  if (resolvedAvatarURL !== undefined) {
    normalized.avatarURL = resolvedAvatarURL
  }
  return normalized
}

function normalizeEditPayload(payload: WebhookPayload): DiscordWebhookEditPayload {
  const {
    username: _username,
    avatar_url: _avatarUrl,
    avatarURL: _avatarURL,
    webhookAvatar: _webhookAvatar,
    ...rest
  } = payload
  return rest
}

function isInvalidWebhookError(error: unknown): boolean {
  const status = httpErrorField(error, 'status')
  const code = httpErrorField(error, 'code')
  return status === 403 || status === 404 || code === 403 || code === 404
}

function retryAfterMs(error: unknown): number | undefined {
  const status = httpErrorField(error, 'status')
  const code = httpErrorField(error, 'code')
  if (status !== 429 && code !== 429) return undefined
  if (typeof error !== 'object' || error === null) return 0

  const retryAfter = (error as { retryAfter?: unknown }).retryAfter
  if (typeof retryAfter === 'number' && Number.isFinite(retryAfter)) {
    return retryAfter > 1000 ? retryAfter : retryAfter * 1000
  }

  const retryAfterHeader = (
    error as { headers?: { get(name: string): string | null } }
  ).headers?.get('retry-after')
  if (retryAfterHeader === undefined || retryAfterHeader === null) return 0

  const retryAfterSeconds = Number.parseFloat(retryAfterHeader)
  if (!Number.isFinite(retryAfterSeconds) || retryAfterSeconds < 0) return 0
  return retryAfterSeconds * 1000
}

async function withRateLimitRetry<T>(
  operation: () => Promise<T>,
  sleep: (ms: number) => Promise<void>
): Promise<T> {
  for (;;) {
    try {
      return await operation()
    } catch (error) {
      const ms = retryAfterMs(error)
      if (ms === undefined) throw error
      await sleep(ms)
    }
  }
}

export function createWebhookManager(options: WebhookManagerOptions): WebhookManager {
  const webhookName = options.webhookName ?? DEFAULT_WEBHOOK_NAME
  const sleep = options.sleep ?? defaultSleep
  const cache = new Map<string, ManagedWebhook>()
  const queues = new Map<string, Promise<void>>()
  const webhookAvatarKeys = new Map<string, string>()

  async function fetchTextChannel(channelId: string): Promise<WebhookChannel> {
    const channel = await options.client.channels.fetch(channelId)
    if (!channel || !channel.isTextBased()) {
      throw new Error(`Discord channel ${channelId} is not a text channel`)
    }
    return channel
  }

  /**
   * Resolve a channelId to the channel that owns webhooks. For thread channels,
   * webhooks live on the parent text channel; we fetch and cache against the
   * parent. Returns `{ webhookChannelId, threadId }` where `threadId` is set
   * iff the input channelId was a thread (so callers can pass it on send/edit).
   */
  async function resolveWebhookContainer(channelId: string): Promise<{
    webhookChannelId: string
    threadId?: string
    container: WebhookChannel
  }> {
    const channel = await fetchTextChannel(channelId)
    const isThread = typeof channel.isThread === 'function' && channel.isThread()
    if (isThread && channel.parentId) {
      const parent = await fetchTextChannel(channel.parentId)
      return { webhookChannelId: channel.parentId, threadId: channelId, container: parent }
    }
    return { webhookChannelId: channelId, container: channel }
  }

  async function getOrCreateWebhook(channelId: string): Promise<ManagedWebhook> {
    try {
      // Resolve thread → parent so webhook lookup/cache uses the channel that
      // actually owns webhooks. Threads inherit webhooks from their parent.
      const { webhookChannelId, container } = await resolveWebhookContainer(channelId)

      const cached = cache.get(webhookChannelId)
      if (cached !== undefined) {
        log.debug('gw.discord.webhook.resolve', {
          data: { channelId, webhookId: cached.id, outcome: 'cached' },
        })
        return cached
      }

      if (typeof container.fetchWebhooks !== 'function') {
        throw new Error(
          `Discord channel ${webhookChannelId} does not support fetchWebhooks (resolved from ${channelId})`
        )
      }
      const webhooks = await container.fetchWebhooks()
      for (const webhook of webhookValues(webhooks)) {
        if (webhook.name === webhookName) {
          cache.set(webhookChannelId, webhook)
          log.info('gw.discord.webhook.resolve', {
            data: { channelId, webhookId: webhook.id, outcome: 'existing' },
          })
          return webhook
        }
      }

      if (typeof container.createWebhook !== 'function') {
        throw new Error(
          `Discord channel ${webhookChannelId} does not support createWebhook (resolved from ${channelId})`
        )
      }
      const webhook = await container.createWebhook({ name: webhookName })
      cache.set(webhookChannelId, webhook)
      log.info('gw.discord.webhook.resolve', {
        data: { channelId, webhookId: webhook.id, outcome: 'created' },
      })
      return webhook
    } catch (error) {
      log.warn('gw.discord.webhook.resolve', {
        data: { channelId, outcome: 'error' },
        err: { message: error instanceof Error ? error.message : String(error) },
      })
      throw error
    }
  }

  async function findWebhookById(channelId: string, webhookId: string): Promise<ManagedWebhook> {
    try {
      // Resolve thread → parent so we look up the webhook on the channel that
      // owns it.
      const { webhookChannelId, container } = await resolveWebhookContainer(channelId)

      const cached = cache.get(webhookChannelId)
      if (cached?.id === webhookId) {
        log.debug('gw.discord.webhook.resolve', {
          data: { channelId, webhookId, outcome: 'cached' },
        })
        return cached
      }

      if (typeof container.fetchWebhooks !== 'function') {
        throw new Error(
          `Discord channel ${webhookChannelId} does not support fetchWebhooks (resolved from ${channelId})`
        )
      }
      const webhooks = await container.fetchWebhooks()
      for (const webhook of webhookValues(webhooks)) {
        if (webhook.id === webhookId) {
          cache.set(webhookChannelId, webhook)
          log.info('gw.discord.webhook.resolve', {
            data: { channelId, webhookId, outcome: 'by_id' },
          })
          return webhook
        }
      }

      throw new Error(`Discord webhook ${webhookId} was not found in channel ${channelId}`)
    } catch (error) {
      log.warn('gw.discord.webhook.resolve', {
        data: { channelId, webhookId, outcome: 'error' },
        err: { message: error instanceof Error ? error.message : String(error) },
      })
      throw error
    }
  }

  /**
   * If the input channelId is a thread, return its id so callers can pass
   * `threadId` on send/edit (so the webhook posts INTO the thread, not the
   * parent channel). Returns undefined for non-thread channels.
   */
  async function resolveThreadIdForPost(channelId: string): Promise<string | undefined> {
    try {
      const { threadId } = await resolveWebhookContainer(channelId)
      return threadId
    } catch {
      return undefined
    }
  }

  async function enqueue<T>(channelId: string, operation: () => Promise<T>): Promise<T> {
    const previous = queues.get(channelId) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(operation)
    const tail = current.then(
      () => undefined,
      () => undefined
    )
    queues.set(channelId, tail)

    try {
      return await current
    } finally {
      if (queues.get(channelId) === tail) {
        queues.delete(channelId)
      }
    }
  }

  async function runWebhookOperation<T>(
    channelId: string,
    webhookId: string | undefined,
    operation: (webhook: ManagedWebhook) => Promise<T>
  ): Promise<T> {
    return enqueue(channelId, async () => {
      try {
        return await withRateLimitRetry(
          async () =>
            operation(
              webhookId === undefined
                ? await getOrCreateWebhook(channelId)
                : await findWebhookById(channelId, webhookId)
            ),
          sleep
        )
      } catch (error) {
        if (isInvalidWebhookError(error)) {
          const cached = cache.get(channelId)
          if (webhookId === undefined || cached?.id === webhookId) {
            cache.delete(channelId)
          }
        }
        throw error
      }
    })
  }

  async function ensureWebhookAvatar(
    webhook: ManagedWebhook,
    avatar: WebhookAvatarOverride | undefined
  ): Promise<void> {
    if (avatar === undefined || webhookAvatarKeys.get(webhook.id) === avatar.key) {
      return
    }

    if (typeof webhook.edit !== 'function') {
      throw new Error(`Discord webhook ${webhook.id} does not support avatar edits`)
    }

    await webhook.edit({ avatar: avatar.data })
    webhookAvatarKeys.set(webhook.id, avatar.key)
    log.info('gw.discord.webhook.avatar', {
      data: { webhookId: webhook.id, avatarKey: avatar.key, outcome: 'updated' },
    })
  }

  return {
    getOrCreateWebhook,
    async send(channelId, payload) {
      let resolvedWebhookId: string | undefined
      const webhookAvatar = payload.webhookAvatar
      try {
        const threadId = await resolveThreadIdForPost(channelId)
        const sendPayload = {
          ...normalizeSendPayload(payload),
          ...(threadId !== undefined ? { threadId } : {}),
        }
        const message = await runWebhookOperation(channelId, undefined, (webhook) => {
          resolvedWebhookId = webhook.id
          return ensureWebhookAvatar(webhook, webhookAvatar).then(() => webhook.send(sendPayload))
        })
        log.info('gw.discord.webhook.send', {
          data: {
            channelId,
            webhookId: resolvedWebhookId,
            messageId: message.id,
            outcome: 'sent',
          },
        })
        return message
      } catch (error) {
        log.warn('gw.discord.webhook.send', {
          data: {
            channelId,
            ...(resolvedWebhookId !== undefined ? { webhookId: resolvedWebhookId } : {}),
            outcome: 'error',
          },
          err: { message: error instanceof Error ? error.message : String(error) },
        })
        throw error
      }
    },
    async editMessage(
      channelId: string,
      messageId: string,
      webhookIdOrPayload: string | WebhookPayload,
      maybePayload?: WebhookPayload
    ) {
      const webhookId = typeof webhookIdOrPayload === 'string' ? webhookIdOrPayload : undefined
      const payload = typeof webhookIdOrPayload === 'string' ? maybePayload : webhookIdOrPayload
      if (payload === undefined) {
        throw new Error('Webhook edit payload is required')
      }

      // Discord edit options do not support username/avatar overrides; the
      // placeholder must be created with the right identity before this edit.
      const baseEditPayload = normalizeEditPayload(payload)
      let resolvedWebhookId: string | undefined = webhookId
      try {
        const threadId = await resolveThreadIdForPost(channelId)
        const editPayload = {
          ...baseEditPayload,
          ...(threadId !== undefined ? { threadId } : {}),
        }
        const message = await runWebhookOperation(channelId, webhookId, (webhook) => {
          resolvedWebhookId = webhook.id
          return webhook.editMessage(messageId, editPayload)
        })
        log.info('gw.discord.webhook.edit', {
          data: {
            channelId,
            webhookId: resolvedWebhookId,
            messageId,
            outcome: 'edited',
          },
        })
        return message
      } catch (error) {
        log.warn('gw.discord.webhook.edit', {
          data: {
            channelId,
            ...(resolvedWebhookId !== undefined ? { webhookId: resolvedWebhookId } : {}),
            messageId,
            outcome: 'error',
          },
          err: { message: error instanceof Error ? error.message : String(error) },
        })
        throw error
      }
    },
    async editMessageOnce(channelId, messageId, webhookId, payload) {
      const baseEditPayload = normalizeEditPayload(payload)
      let resolvedWebhookId: string | undefined = webhookId
      try {
        const threadId = await resolveThreadIdForPost(channelId)
        const editPayload = {
          ...baseEditPayload,
          ...(threadId !== undefined ? { threadId } : {}),
        }
        const message = await enqueue(channelId, async () => {
          const webhook = await findWebhookById(channelId, webhookId)
          resolvedWebhookId = webhook.id
          return webhook.editMessage(messageId, editPayload)
        })
        log.info('gw.discord.webhook.edit', {
          data: {
            channelId,
            webhookId: resolvedWebhookId,
            messageId,
            outcome: 'edited',
          },
        })
        return message
      } catch (error) {
        if (isInvalidWebhookError(error)) {
          const cached = cache.get(channelId)
          if (cached?.id === webhookId) {
            cache.delete(channelId)
          }
        }
        log.warn('gw.discord.webhook.edit', {
          data: {
            channelId,
            ...(resolvedWebhookId !== undefined ? { webhookId: resolvedWebhookId } : {}),
            messageId,
            outcome: 'error',
          },
          err: { message: error instanceof Error ? error.message : String(error) },
        })
        throw error
      }
    },
  }
}
