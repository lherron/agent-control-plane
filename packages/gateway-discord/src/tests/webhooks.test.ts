import { describe, expect, test } from 'bun:test'

type WebhookPayload = {
  content: string
  username?: string | undefined
  avatar_url?: string | undefined
  avatarURL?: string | undefined
  webhookAvatar?: { key: string; data: Buffer } | undefined
}

class FakeWebhookClient {
  readonly sends: WebhookPayload[] = []
  readonly edits: Array<{ messageId: string; payload: WebhookPayload }> = []
  readonly avatarEdits: Array<{ avatar?: Buffer | string | null | undefined }> = []
  readonly attempts: string[] = []
  queuedErrors: unknown[] = []
  persistentError: unknown

  constructor(
    readonly id: string,
    readonly token: string,
    readonly name: string
  ) {}

  async send(payload: WebhookPayload): Promise<{ id: string }> {
    this.attempts.push(payload.content)
    if (this.persistentError) throw this.persistentError
    const error = this.queuedErrors.shift()
    if (error) throw error
    this.sends.push(payload)
    return { id: `message_${this.sends.length}` }
  }

  async editMessage(messageId: string, payload: WebhookPayload): Promise<{ id: string }> {
    this.edits.push({ messageId, payload })
    return { id: messageId }
  }

  async edit(input: {
    avatar?: Buffer | string | null | undefined
  }): Promise<this> {
    this.avatarEdits.push(input)
    return this
  }
}

class FakeChannel {
  readonly webhooks = new Map<string, FakeWebhookClient>()
  createWebhookCount = 0

  constructor(readonly id: string) {}

  isTextBased(): true {
    return true
  }

  async fetchWebhooks(): Promise<Map<string, FakeWebhookClient>> {
    return this.webhooks
  }

  async createWebhook(options: { name: string }): Promise<FakeWebhookClient> {
    this.createWebhookCount += 1
    const webhook = new FakeWebhookClient(
      `webhook_${this.createWebhookCount}`,
      `token_${this.createWebhookCount}`,
      options.name
    )
    this.webhooks.set(webhook.id, webhook)
    return webhook
  }
}

class FakeClient {
  readonly channels = {
    fetch: async (id: string) => this.channelsById.get(id) ?? null,
  }

  readonly channelsById = new Map<string, FakeChannel>()

  addChannel(channel: FakeChannel): void {
    this.channelsById.set(channel.id, channel)
  }
}

async function loadWebhooksModule(): Promise<{
  createWebhookManager: (options: {
    client: FakeClient
    webhookName?: string | undefined
    sleep?: ((ms: number) => Promise<void>) | undefined
  }) => {
    getOrCreateWebhook: (channelId: string) => Promise<FakeWebhookClient>
    send: (
      channelId: string,
      payload: WebhookPayload,
      options?: { maxRateLimitAttempts?: number | undefined } | undefined
    ) => Promise<{ id: string }>
    editMessage: (
      channelId: string,
      messageId: string,
      webhookId: string,
      payload: WebhookPayload
    ) => Promise<{ id: string }>
    editMessage: (
      channelId: string,
      messageId: string,
      payload: WebhookPayload
    ) => Promise<{ id: string }>
  }
}> {
  return import('../webhooks.js')
}

function discordError(status: number): Error & { status: number; code: number } {
  const error = new Error(`Discord ${status}`) as Error & {
    status: number
    code: number
  }
  error.status = status
  error.code = status
  return error
}

function rateLimitError(retryAfterSeconds: string): Error & {
  status: number
  headers: { get(name: string): string | null }
} {
  const error = new Error('Discord 429') as Error & {
    status: number
    headers: { get(name: string): string | null }
  }
  error.status = 429
  error.headers = {
    get: (name: string) => (name.toLowerCase() === 'retry-after' ? retryAfterSeconds : null),
  }
  return error
}

describe('Discord webhook provisioning', () => {
  test('creates agent-pulpit once and returns the cached webhook on later calls', async () => {
    const { createWebhookManager } = await loadWebhooksModule()
    const client = new FakeClient()
    const channel = new FakeChannel('chan_identity')
    client.addChannel(channel)
    const manager = createWebhookManager({
      client,
      webhookName: 'agent-pulpit',
    })

    const first = await manager.getOrCreateWebhook(channel.id)
    const second = await manager.getOrCreateWebhook(channel.id)

    expect(first).toBe(second)
    expect(first.name).toBe('agent-pulpit')
    expect(channel.createWebhookCount).toBe(1)
  })

  test('reuses an existing agent-pulpit webhook instead of creating another one', async () => {
    const { createWebhookManager } = await loadWebhooksModule()
    const client = new FakeClient()
    const channel = new FakeChannel('chan_existing')
    const existing = await channel.createWebhook({ name: 'agent-pulpit' })
    client.addChannel(channel)
    const manager = createWebhookManager({
      client,
      webhookName: 'agent-pulpit',
    })

    const resolved = await manager.getOrCreateWebhook(channel.id)

    expect(resolved).toBe(existing)
    expect(channel.createWebhookCount).toBe(1)
  })

  test('never reuses a same-name webhook whose token is unavailable', async () => {
    const { createWebhookManager } = await loadWebhooksModule()
    const client = new FakeClient()
    const channel = new FakeChannel('chan_tokenless_existing')
    const tokenless = new FakeWebhookClient('foreign_webhook', '', 'agent-pulpit')
    channel.webhooks.set(tokenless.id, tokenless)
    client.addChannel(channel)
    const manager = createWebhookManager({
      client,
      webhookName: 'agent-pulpit',
    })

    await manager.send(channel.id, { content: 'must use a tokenful webhook' })

    expect(tokenless.attempts).toEqual([])
    expect(channel.createWebhookCount).toBe(1)
    expect([...channel.webhooks.values()].at(-1)?.token).toBe('token_1')
  })

  test('invalidates a cached webhook after 404 or 403 and re-provisions on the next send', async () => {
    const { createWebhookManager } = await loadWebhooksModule()
    const client = new FakeClient()
    const channel = new FakeChannel('chan_invalidated')
    client.addChannel(channel)
    const manager = createWebhookManager({
      client,
      webhookName: 'agent-pulpit',
    })

    const stale = await manager.getOrCreateWebhook(channel.id)
    stale.queuedErrors.push(discordError(404))

    await expect(manager.send(channel.id, { content: 'first attempt' })).rejects.toThrow(
      'Discord 404'
    )
    channel.webhooks.delete(stale.id)
    await manager.send(channel.id, { content: 'second attempt' })

    expect(channel.createWebhookCount).toBe(2)
    const active = [...channel.webhooks.values()].at(-1)
    expect(active).not.toBe(stale)
    expect(active?.sends.map((payload) => payload.content)).toEqual(['second attempt'])
  })
})

describe('Discord webhook payloads', () => {
  test('passes avatarURL through to discord.js using camelCase', async () => {
    const { createWebhookManager } = await loadWebhooksModule()
    const client = new FakeClient()
    const channel = new FakeChannel('chan_avatar_camel')
    client.addChannel(channel)
    const manager = createWebhookManager({
      client,
      webhookName: 'agent-pulpit',
    })

    await manager.send(channel.id, {
      content: 'agent message',
      username: 'cody',
      avatarURL: 'https://example.test/cody.png',
    })

    const webhook = await manager.getOrCreateWebhook(channel.id)
    expect(webhook.sends).toEqual([
      {
        content: 'agent message',
        username: 'cody',
        avatarURL: 'https://example.test/cody.png',
      },
    ])
  })

  test('maps legacy avatar_url to discord.js avatarURL and strips snake_case', async () => {
    const { createWebhookManager } = await loadWebhooksModule()
    const client = new FakeClient()
    const channel = new FakeChannel('chan_avatar_snake')
    client.addChannel(channel)
    const manager = createWebhookManager({
      client,
      webhookName: 'agent-pulpit',
    })

    await manager.send(channel.id, {
      content: 'legacy agent message',
      username: 'larry',
      avatar_url: 'https://example.test/larry.png',
    })

    const webhook = await manager.getOrCreateWebhook(channel.id)
    expect(webhook.sends).toEqual([
      {
        content: 'legacy agent message',
        username: 'larry',
        avatarURL: 'https://example.test/larry.png',
      },
    ])
  })

  test('applies local profile avatar bytes to the webhook before send', async () => {
    const { createWebhookManager } = await loadWebhooksModule()
    const client = new FakeClient()
    const channel = new FakeChannel('chan_avatar_bytes')
    client.addChannel(channel)
    const manager = createWebhookManager({
      client,
      webhookName: 'agent-pulpit',
    })
    const avatar = Buffer.from('fake-png-bytes')

    await manager.send(channel.id, {
      content: 'agent message',
      username: 'cody',
      webhookAvatar: {
        key: 'cody:/v1/assets/agents/cody/pfp.png',
        data: avatar,
      },
    })

    const webhook = await manager.getOrCreateWebhook(channel.id)
    expect(webhook.avatarEdits).toEqual([{ avatar }])
    expect(webhook.sends).toEqual([
      {
        content: 'agent message',
        username: 'cody',
      },
    ])
  })
})

describe('Discord webhook edits', () => {
  test('edits through the explicit webhook id that created the placeholder', async () => {
    const { createWebhookManager } = await loadWebhooksModule()
    const client = new FakeClient()
    const channel = new FakeChannel('chan_edit_by_id')
    const firstWebhook = await channel.createWebhook({ name: 'agent-pulpit' })
    const placeholderWebhook = await channel.createWebhook({
      name: 'agent-pulpit',
    })
    client.addChannel(channel)
    const manager = createWebhookManager({
      client,
      webhookName: 'agent-pulpit',
    })

    await manager.getOrCreateWebhook(channel.id)
    await manager.editMessage(channel.id, 'placeholder_message', placeholderWebhook.id, {
      content: 'final content',
      username: 'cody',
      avatarURL: 'https://example.test/cody.png',
      avatar_url: 'https://example.test/legacy.png',
    })

    expect(firstWebhook.edits).toEqual([])
    expect(placeholderWebhook.edits).toEqual([
      {
        messageId: 'placeholder_message',
        payload: { content: 'final content' },
      },
    ])
  })

  test('fails an explicit edit when the requested webhook id is missing', async () => {
    const { createWebhookManager } = await loadWebhooksModule()
    const client = new FakeClient()
    const channel = new FakeChannel('chan_missing_edit_webhook')
    await channel.createWebhook({ name: 'agent-pulpit' })
    client.addChannel(channel)
    const manager = createWebhookManager({
      client,
      webhookName: 'agent-pulpit',
    })

    await expect(
      manager.editMessage(channel.id, 'placeholder_message', 'missing_webhook', {
        content: 'final content',
      })
    ).rejects.toThrow('Discord webhook missing_webhook was not found')
  })

  test('rejects an explicit token-less webhook before attempting an edit', async () => {
    const { createWebhookManager } = await loadWebhooksModule()
    const client = new FakeClient()
    const channel = new FakeChannel('chan_tokenless_edit')
    const tokenless = new FakeWebhookClient('tokenless_webhook', '', 'agent-pulpit')
    channel.webhooks.set(tokenless.id, tokenless)
    client.addChannel(channel)
    const manager = createWebhookManager({
      client,
      webhookName: 'agent-pulpit',
    })

    await expect(
      manager.editMessage(channel.id, 'placeholder_message', tokenless.id, {
        content: 'final content',
      })
    ).rejects.toThrow('has no usable token')
    expect(tokenless.edits).toEqual([])
  })
})

describe('Discord webhook rate limiting', () => {
  test('retries 429 sends after Retry-After', async () => {
    const { createWebhookManager } = await loadWebhooksModule()
    const client = new FakeClient()
    const channel = new FakeChannel('chan_rate_limit')
    client.addChannel(channel)
    const slept: number[] = []
    const manager = createWebhookManager({
      client,
      webhookName: 'agent-pulpit',
      sleep: async (ms) => {
        slept.push(ms)
      },
    })
    const webhook = await manager.getOrCreateWebhook(channel.id)
    webhook.queuedErrors.push(rateLimitError('0.25'))

    await manager.send(channel.id, { content: 'rate limited once' })

    expect(slept).toEqual([250])
    expect(webhook.attempts).toEqual(['rate limited once', 'rate limited once'])
    expect(webhook.sends.map((payload) => payload.content)).toEqual(['rate limited once'])
  })

  test('queues later sends in the same channel behind a 429 backoff', async () => {
    const { createWebhookManager } = await loadWebhooksModule()
    const client = new FakeClient()
    const channel = new FakeChannel('chan_queued')
    client.addChannel(channel)
    const slept: number[] = []
    const manager = createWebhookManager({
      client,
      webhookName: 'agent-pulpit',
      sleep: async (ms) => {
        slept.push(ms)
      },
    })
    const webhook = await manager.getOrCreateWebhook(channel.id)
    webhook.queuedErrors.push(rateLimitError('0.1'))

    await Promise.all([
      manager.send(channel.id, { content: 'first' }),
      manager.send(channel.id, { content: 'second' }),
    ])

    expect(slept).toEqual([100])
    expect(webhook.attempts).toEqual(['first', 'first', 'second'])
    expect(webhook.sends.map((payload) => payload.content)).toEqual(['first', 'second'])
  })

  test('retries an unset ceiling without bound, exactly as before', async () => {
    const { createWebhookManager } = await loadWebhooksModule()
    const client = new FakeClient()
    const channel = new FakeChannel('chan_unbounded')
    client.addChannel(channel)
    const slept: number[] = []
    const manager = createWebhookManager({
      client,
      webhookName: 'agent-pulpit',
      sleep: async (ms) => {
        slept.push(ms)
      },
    })
    const webhook = await manager.getOrCreateWebhook(channel.id)
    for (let i = 0; i < 6; i += 1) {
      webhook.queuedErrors.push(rateLimitError('0.1'))
    }

    await manager.send(channel.id, { content: 'unbounded' })

    expect(slept).toEqual([100, 100, 100, 100, 100, 100])
    expect(webhook.attempts).toHaveLength(7)
    expect(webhook.sends.map((payload) => payload.content)).toEqual(['unbounded'])
  })

  test('T7: a persistent 429 throws once the ceiling is reached instead of looping forever', async () => {
    const { createWebhookManager } = await loadWebhooksModule()
    const client = new FakeClient()
    const channel = new FakeChannel('chan_ceiling')
    client.addChannel(channel)
    const slept: number[] = []
    const manager = createWebhookManager({
      client,
      webhookName: 'agent-pulpit',
      sleep: async (ms) => {
        slept.push(ms)
      },
    })
    const webhook = await manager.getOrCreateWebhook(channel.id)
    webhook.persistentError = rateLimitError('0.1')

    await expect(
      manager.send(channel.id, { content: 'always rate limited' }, { maxRateLimitAttempts: 3 })
    ).rejects.toThrow('Discord 429')

    expect(webhook.attempts).toHaveLength(3)
    expect(slept).toEqual([100, 100])
    expect(webhook.sends).toHaveLength(0)

    // The channel queue is free again, so the next send is not held behind it.
    webhook.persistentError = undefined
    await manager.send(channel.id, { content: 'after the ceiling' })
    expect(webhook.sends.map((payload) => payload.content)).toEqual(['after the ceiling'])
  })

  test('rejects a ceiling that is not a positive integer', async () => {
    const { createWebhookManager } = await loadWebhooksModule()
    const client = new FakeClient()
    const channel = new FakeChannel('chan_bad_ceiling')
    client.addChannel(channel)
    const manager = createWebhookManager({
      client,
      webhookName: 'agent-pulpit',
    })

    await expect(
      manager.send(channel.id, { content: 'nope' }, { maxRateLimitAttempts: 0 })
    ).rejects.toThrow('maxRateLimitAttempts must be a positive integer')
  })

  test('does not sleep or queue-penalize successful sends', async () => {
    const { createWebhookManager } = await loadWebhooksModule()
    const client = new FakeClient()
    const channel = new FakeChannel('chan_fast')
    client.addChannel(channel)
    const slept: number[] = []
    const manager = createWebhookManager({
      client,
      webhookName: 'agent-pulpit',
      sleep: async (ms) => {
        slept.push(ms)
      },
    })

    await manager.send(channel.id, { content: 'fast path' })

    expect(slept).toEqual([])
    expect((await manager.getOrCreateWebhook(channel.id)).sends).toHaveLength(1)
  })
})
