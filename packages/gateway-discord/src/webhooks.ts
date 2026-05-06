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

export type ManagedWebhook = {
  id: string
  token?: string | null | undefined
  name?: string | null | undefined
  send(payload: WebhookPayload): Promise<WebhookMessage>
  editMessage(messageId: string, payload: WebhookPayload): Promise<WebhookMessage>
}

export type WebhookChannel = {
  isTextBased(): boolean
  fetchWebhooks(): Promise<Iterable<ManagedWebhook> | Map<string, ManagedWebhook>>
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

export function createWebhookManager(_options: WebhookManagerOptions): WebhookManager {
  throw new Error('createWebhookManager is not implemented')
}
