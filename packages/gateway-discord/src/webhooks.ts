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

type WebhookCollection =
  | Iterable<ManagedWebhook>
  | {
      values(): Iterable<ManagedWebhook>
    }

export type ManagedWebhook = {
  id: string
  token?: string | null | undefined
  name?: string | null | undefined
  send(payload: WebhookPayload): Promise<WebhookMessage>
  editMessage(messageId: string, payload: WebhookPayload): Promise<WebhookMessage>
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
    payload: WebhookPayload
  ): Promise<WebhookMessage>
}

const DEFAULT_WEBHOOK_NAME = 'agent-pulpit'

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function webhookValues(collection: WebhookCollection): Iterable<ManagedWebhook> {
  if ('values' in collection && typeof collection.values === 'function') {
    return collection.values()
  }
  return collection as Iterable<ManagedWebhook>
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

  async function getOrCreateWebhook(channelId: string): Promise<ManagedWebhook> {
    const cached = cache.get(channelId)
    if (cached !== undefined) return cached

    const channel = await options.client.channels.fetch(channelId)
    if (!channel || !channel.isTextBased()) {
      throw new Error(`Discord channel ${channelId} is not a text channel`)
    }

    const webhooks = await channel.fetchWebhooks()
    for (const webhook of webhookValues(webhooks)) {
      if (webhook.name === webhookName) {
        cache.set(channelId, webhook)
        return webhook
      }
    }

    const webhook = await channel.createWebhook({ name: webhookName })
    cache.set(channelId, webhook)
    return webhook
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
    operation: (webhook: ManagedWebhook) => Promise<T>
  ): Promise<T> {
    return enqueue(channelId, async () => {
      try {
        return await withRateLimitRetry(
          async () => operation(await getOrCreateWebhook(channelId)),
          sleep
        )
      } catch (error) {
        if (isInvalidWebhookError(error)) {
          cache.delete(channelId)
        }
        throw error
      }
    })
  }

  return {
    getOrCreateWebhook,
    send(channelId, payload) {
      return runWebhookOperation(channelId, (webhook) => webhook.send(payload))
    },
    editMessage(channelId, messageId, payload) {
      return runWebhookOperation(channelId, (webhook) => webhook.editMessage(messageId, payload))
    },
  }
}
