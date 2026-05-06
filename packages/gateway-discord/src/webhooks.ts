import { createLogger } from './logger.js'

export type WebhookPayload = {
  content: string
  username?: string | undefined
  avatar_url?: string | undefined
  avatarURL?: string | undefined
  files?: unknown[] | undefined
  components?: unknown[] | undefined
}

export type WebhookMessage = {
  id: string
}

type DiscordWebhookSendPayload = Omit<WebhookPayload, 'avatar_url' | 'avatarURL'> & {
  avatarURL?: string | undefined
}

type DiscordWebhookEditPayload = Omit<WebhookPayload, 'avatar_url' | 'avatarURL' | 'username'>

type WebhookCollection =
  | Iterable<ManagedWebhook>
  | {
      values(): Iterable<ManagedWebhook>
    }

export type ManagedWebhook = {
  id: string
  token?: string | null | undefined
  name?: string | null | undefined
  send(payload: DiscordWebhookSendPayload): Promise<WebhookMessage>
  editMessage(messageId: string, payload: DiscordWebhookEditPayload): Promise<WebhookMessage>
}

export type WebhookChannel = {
  isTextBased(): boolean
  fetchWebhooks(): Promise<WebhookCollection>
  createWebhook(options: { name: string }): Promise<ManagedWebhook>
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
  const { avatar_url: avatarUrl, avatarURL, ...rest } = payload
  const normalized: DiscordWebhookSendPayload = { ...rest }
  const resolvedAvatarURL = avatarURL ?? avatarUrl
  if (resolvedAvatarURL !== undefined) {
    normalized.avatarURL = resolvedAvatarURL
  }
  return normalized
}

function normalizeEditPayload(payload: WebhookPayload): DiscordWebhookEditPayload {
  const { username: _username, avatar_url: _avatarUrl, avatarURL: _avatarURL, ...rest } = payload
  return rest
}

function errorValue(error: unknown, key: 'status' | 'code'): unknown {
  return typeof error === 'object' && error !== null
    ? (error as Record<string, unknown>)[key]
    : undefined
}

function isInvalidWebhookError(error: unknown): boolean {
  const status = errorValue(error, 'status')
  const code = errorValue(error, 'code')
  return status === 403 || status === 404 || code === 403 || code === 404
}

function retryAfterMs(error: unknown): number | undefined {
  const status = errorValue(error, 'status')
  const code = errorValue(error, 'code')
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

  async function fetchTextChannel(channelId: string): Promise<WebhookChannel> {
    const channel = await options.client.channels.fetch(channelId)
    if (!channel || !channel.isTextBased()) {
      throw new Error(`Discord channel ${channelId} is not a text channel`)
    }
    return channel
  }

  async function getOrCreateWebhook(channelId: string): Promise<ManagedWebhook> {
    try {
      const cached = cache.get(channelId)
      if (cached !== undefined) {
        log.debug('gw.discord.webhook.resolve', {
          data: { channelId, webhookId: cached.id, outcome: 'cached' },
        })
        return cached
      }

      const channel = await fetchTextChannel(channelId)

      const webhooks = await channel.fetchWebhooks()
      for (const webhook of webhookValues(webhooks)) {
        if (webhook.name === webhookName) {
          cache.set(channelId, webhook)
          log.info('gw.discord.webhook.resolve', {
            data: { channelId, webhookId: webhook.id, outcome: 'existing' },
          })
          return webhook
        }
      }

      const webhook = await channel.createWebhook({ name: webhookName })
      cache.set(channelId, webhook)
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
      const cached = cache.get(channelId)
      if (cached?.id === webhookId) {
        log.debug('gw.discord.webhook.resolve', {
          data: { channelId, webhookId, outcome: 'cached' },
        })
        return cached
      }

      const channel = await fetchTextChannel(channelId)
      const webhooks = await channel.fetchWebhooks()
      for (const webhook of webhookValues(webhooks)) {
        if (webhook.id === webhookId) {
          cache.set(channelId, webhook)
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

  return {
    getOrCreateWebhook,
    async send(channelId, payload) {
      let resolvedWebhookId: string | undefined
      try {
        const message = await runWebhookOperation(channelId, undefined, (webhook) => {
          resolvedWebhookId = webhook.id
          return webhook.send(normalizeSendPayload(payload))
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
      const editPayload = normalizeEditPayload(payload)
      let resolvedWebhookId: string | undefined = webhookId
      try {
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
  }
}
