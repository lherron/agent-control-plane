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
  readonly edits: Array<{
    messageId: string
    payload: FakeWebhookSendPayload
  }> = []
  readonly avatarEdits: Array<{ avatar?: Buffer | string | null | undefined }> = []
  readonly sendAttempts: FakeWebhookSendPayload[] = []
  failNextSendWith: unknown
  private nextId = 1

  constructor(
    readonly id: string,
    readonly token: string,
    readonly name: string,
    readonly channelId: string
  ) {}

  async send(input: string | FakeWebhookSendPayload): Promise<FakeSentMessage> {
    this.sendAttempts.push(typeof input === 'string' ? { content: input } : input)
    if (this.failNextSendWith !== undefined) {
      const error = this.failNextSendWith
      this.failNextSendWith = undefined
      throw error
    }
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

  async edit(input: {
    avatar?: Buffer | string | null | undefined
  }): Promise<this> {
    this.avatarEdits.push(input)
    return this
  }

  async deleteMessage(messageId: string): Promise<void> {
    const entry = this.sent.find((item) => item.message.id === messageId)
    if (entry) await entry.message.delete()
  }
}

export class FakeChannel {
  readonly sent: Array<
    FakeSendPayload & { replyTo?: string | undefined; message: FakeSentMessage }
  > = []
  readonly webhooks = new Map<string, FakeWebhook>()
  readonly messages = {
    fetch: async (id: string) => this.messageById.get(id) ?? null,
  }

  private nextId = 1
  private readonly messageById = new Map<string, FakeSentMessage>()
  typingPings = 0

  constructor(readonly id: string) {}

  isTextBased(): true {
    return true
  }

  async sendTyping(): Promise<void> {
    this.typingPings += 1
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

/** Construct the local Discord client with its complete channel roster. */
export function createClient(...channels: FakeChannel[]): FakeClient {
  const client = new FakeClient()
  for (const channel of channels) client.addChannel(channel)
  return client
}
