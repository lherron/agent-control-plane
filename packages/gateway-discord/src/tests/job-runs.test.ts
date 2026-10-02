import { describe, expect, test } from 'bun:test'

import { GatewayDiscordApp } from '../app.js'
import { JobRunFailureCardLimiter, buildJobRunCard } from '../job-runs.js'
import { createWebhookManager, webhookPayloadHasContent } from '../webhooks.js'

function dispatchedEvent(overrides: Record<string, unknown> = {}) {
  return {
    eventId: '10',
    kind: 'job.dispatched',
    projectId: 'agent-control-plane',
    occurredAt: '2026-06-28T09:00:00.000Z',
    payload: {
      jobId: 'job-1',
      jobRunId: 'jr-1',
      jobSlug: 'daily-standup',
      agentId: 'clod',
      projectId: 'agent-control-plane',
      scopeRef: 'agent:clod:project:agent-control-plane:task:T-05245',
      laneRef: 'main',
      triggeredBy: 'schedule',
      trigger: { kind: 'schedule', cron: '0 9 * * *' },
      runId: 'run-1',
      ...overrides,
    },
  }
}

describe('buildJobRunCard (T-05245)', () => {
  test('renders a started embed card with the spec-locked fields', () => {
    const card = buildJobRunCard(dispatchedEvent())
    expect(card).toBeDefined()
    expect(card?.content).toBeUndefined() // embed-only, no redundant text body
    expect(card?.username).toBe('clod · jobs')
    const embed = (card?.embeds?.[0] ?? {}) as Record<string, unknown>
    expect(embed['title']).toBe('▶ Job started · daily-standup')
    const fieldValues = Object.fromEntries(
      (embed['fields'] as Array<{ name: string; value: string }>).map((f) => [f.name, f.value])
    )
    expect(fieldValues).toMatchObject({
      Agent: 'clod',
      Project: 'agent-control-plane',
      Task: 'T-05245', // parsed from scopeRef
      Terminal: '[Focus](http://max3.tail53cc3b.ts.net:18450/focus/T-05245)',
      Trigger: '0 9 * * *',
      Run: 'run-1',
    })
    expect((embed['footer'] as { text: string }).text).toBe('jobRun jr-1')
  })

  test('completed-failed card: status in title, no Trigger/Status fields, carries Error', () => {
    const card = buildJobRunCard({
      ...dispatchedEvent({ status: 'failed', errorMessage: 'boom' }),
      eventId: '11',
      kind: 'job.completed',
    })
    const embed = (card?.embeds?.[0] ?? {}) as Record<string, unknown>
    expect(embed['title']).toBe('✗ Job failed · daily-standup') // status in title
    expect(embed['color']).toBe(0xed4245)
    const fields = embed['fields'] as Array<{ name: string; value: string }>
    const names = fields.map((f) => f.name)
    expect(names).toEqual(['Agent', 'Project', 'Task', 'Terminal', 'Run', 'Lane', 'Error']) // no Trigger/Status
    expect(fields.find((f) => f.name === 'Error')?.value).toBe('boom')
  })

  test('completed-succeeded card: status in title, renders response markdown in description, no Trigger', () => {
    const card = buildJobRunCard({
      ...dispatchedEvent({ status: 'succeeded', finalResponse: '**done** — see [link](x)' }),
      eventId: '12',
      kind: 'job.completed',
    })
    const embed = (card?.embeds?.[0] ?? {}) as Record<string, unknown>
    expect(embed['title']).toBe('✓ Job succeeded · daily-standup')
    // Response rendered as raw markdown (no code fence) in the description, under
    // the de-emphasized subtitle.
    expect(embed['description']).toContain('**done** — see [link](x)')
    expect(embed['description']).not.toContain('```')
    const fields = embed['fields'] as Array<{ name: string }>
    expect(fields.map((f) => f.name)).toEqual([
      'Agent',
      'Project',
      'Task',
      'Terminal',
      'Run',
      'Lane',
    ])
  })

  test('completed-succeeded without a captured response keeps the subtitle, no Response', () => {
    const event = dispatchedEvent({ status: 'succeeded' })
    ;(event.payload as Record<string, unknown>)['description'] = undefined
    const card = buildJobRunCard({ ...event, eventId: '13', kind: 'job.completed' })
    const embed = (card?.embeds?.[0] ?? {}) as Record<string, unknown>
    expect(embed['description']).toBe('Run succeeded')
    expect((embed['fields'] as Array<{ name: string }>).map((f) => f.name)).toEqual([
      'Agent',
      'Project',
      'Task',
      'Terminal',
      'Run',
      'Lane',
    ])
  })

  test('renders already-emitted job run metadata with bounded fields', () => {
    const card = buildJobRunCard(
      dispatchedEvent({
        inputAttemptId: 'ia_1',
        nextFireAt: '2026-06-29T15:00:00.000Z',
        lastFireAt: '2026-06-28T15:00:00.000Z',
      })
    )
    const fields = Object.fromEntries(
      ((card?.embeds?.[0] as { fields: Array<{ name: string; value: string }> }).fields ?? []).map(
        (field) => [field.name, field.value]
      )
    )
    expect(fields).toMatchObject({
      Run: 'run-1',
      Lane: 'main',
      Input: 'ia_1',
      Next: '2026-06-29T15:00:00.000Z',
      Last: '2026-06-28T15:00:00.000Z',
    })
  })

  test('flow run without a top-level runId renders Task and an em-dash Run', () => {
    const event = dispatchedEvent()
    ;(event.payload as Record<string, unknown>)['runId'] = undefined
    const card = buildJobRunCard(event)
    const fields = (card?.embeds?.[0] as { fields: Array<{ name: string; value: string }> }).fields
    expect(fields.find((f) => f.name === 'Run')?.value).toBe('—')
  })

  test('renders job description as a one-line truncated subtitle when present', () => {
    const long = `multi\nline   description ${'x'.repeat(200)}`
    const card = buildJobRunCard(dispatchedEvent({ description: long }))
    const desc = (card?.embeds?.[0] as { description: string }).description
    expect(desc).not.toContain('\n')
    expect(desc.length).toBeLessThanOrEqual(100)
    expect(desc.endsWith('…')).toBe(true)
  })

  test('falls back to the status phrase when description is absent', () => {
    const event = dispatchedEvent()
    ;(event.payload as Record<string, unknown>)['description'] = undefined
    const card = buildJobRunCard(event)
    expect((card?.embeds?.[0] as { description: string }).description).toBe('Dispatched (schedule)')
  })

  test('ignores non-job system events', () => {
    expect(buildJobRunCard({ ...dispatchedEvent(), kind: 'input.started' })).toBeUndefined()
  })
})

describe('webhook payload at-least-one-of invariant (T-05245)', () => {
  test('webhookPayloadHasContent accepts embed-only and rejects empty', () => {
    expect(webhookPayloadHasContent({ embeds: [{ title: 'x' }] })).toBe(true)
    expect(webhookPayloadHasContent({ content: 'hi' })).toBe(true)
    expect(webhookPayloadHasContent({})).toBe(false)
    expect(webhookPayloadHasContent({ content: '', embeds: [] })).toBe(false)
  })

  test('manager send throws fast on an empty payload', async () => {
    const manager = createWebhookManager({
      client: { channels: { fetch: async () => null } },
    })
    await expect(manager.send('chan', {} as never)).rejects.toThrow(/at least one/)
  })
})

// --- Fakes for the poll-loop test (mirrors webhooks.test.ts) ---
class FakeWebhookClient {
  readonly sends: Array<Record<string, unknown>> = []
  constructor(
    readonly id: string,
    readonly token: string,
    readonly name: string
  ) {}
  async send(payload: Record<string, unknown>): Promise<{ id: string }> {
    this.sends.push(payload)
    return { id: `m_${this.sends.length}` }
  }
  async editMessage(messageId: string): Promise<{ id: string }> {
    return { id: messageId }
  }
  async edit(): Promise<this> {
    return this
  }
}
class FakeChannel {
  readonly webhooks = new Map<string, FakeWebhookClient>()
  count = 0
  constructor(readonly id: string) {}
  isTextBased(): true {
    return true
  }
  async fetchWebhooks(): Promise<Map<string, FakeWebhookClient>> {
    return this.webhooks
  }
  async createWebhook(options: { name: string }): Promise<FakeWebhookClient> {
    this.count += 1
    const wh = new FakeWebhookClient(`wh_${this.count}`, `tok_${this.count}`, options.name)
    this.webhooks.set(wh.id, wh)
    return wh
  }
}
class FakeClient {
  readonly channelsById = new Map<string, FakeChannel>()
  readonly channels = { fetch: async (id: string) => this.channelsById.get(id) ?? null }
  add(channel: FakeChannel): void {
    this.channelsById.set(channel.id, channel)
  }
}

describe('GatewayDiscordApp.pollSystemEventsOnce (T-05245)', () => {
  test('posts only job.* events, advances cursor past all, and ignores bindings', async () => {
    const channel = new FakeChannel('chan-job-runs')
    const client = new FakeClient()
    client.add(channel)

    const events = [
      dispatchedEvent({ jobRunId: 'jr-1' }),
      { eventId: '11', kind: 'input.started', projectId: 'p', occurredAt: 'x', payload: {} },
      {
        ...dispatchedEvent({ jobRunId: 'jr-1' }),
        eventId: '12',
        kind: 'job.completed',
        payload: { ...dispatchedEvent().payload, status: 'succeeded' },
      },
    ]

    const requestedUrls: string[] = []
    const fetchImpl = async (input: unknown) => {
      requestedUrls.push(String(input))
      return {
        ok: true,
        status: 200,
        json: async () => ({ events }),
        text: async () => '',
      } as unknown as Response
    }

    const app = new GatewayDiscordApp({
      acpBaseUrl: 'http://acp.local',
      gatewayId: 'g',
      client: client as never,
      fetchImpl: fetchImpl as never,
      jobRunsChannelId: 'chan-job-runs',
    })

    // No bindings refreshed/registered — proves the path is binding-free.
    const seen = await app.pollSystemEventsOnce()
    expect(seen).toBe(3)

    const webhook = [...channel.webhooks.values()][0]
    expect(webhook?.sends).toHaveLength(2) // 2 job events → 2 cards; input.started skipped
    expect((webhook?.sends[0]?.['embeds'] as unknown[]).length).toBe(1)

    // Cursor advanced past the highest event_id (incl. the non-job event).
    expect(requestedUrls[0]).toContain('afterEventId=0')
    const second = await app.pollSystemEventsOnce()
    expect(second).toBe(3) // fake returns same list, but URL now uses the advanced cursor
    expect(requestedUrls[1]).toContain('afterEventId=12')
  })
})

describe('job-runs failure card rate limit (T-10005)', () => {
  function failedEvent(
    id: number,
    slug = 'transcript-summary-discord',
    errorCode = 'output_delivery_exhausted'
  ) {
    return {
      eventId: String(id),
      kind: 'job.completed',
      projectId: 'media-ingest',
      occurredAt: '2026-10-01T22:00:00.000Z',
      payload: {
        ...dispatchedEvent().payload,
        jobSlug: slug,
        jobRunId: `jr-${id}`,
        agentId: 'mneme',
        projectId: 'media-ingest',
        status: 'failed',
        errorCode,
        errorMessage: 'sink[0] down',
      },
    }
  }

  test('posts 3 failure cards per job per window, then one plain summary when the window rolls', () => {
    let clock = 0
    const limiter = new JobRunFailureCardLimiter({ now: () => clock })
    const admitted = Array.from({ length: 145 }, (_, i) => limiter.admit(failedEvent(i + 1)))
    expect(admitted.filter(Boolean)).toHaveLength(3)
    expect(limiter.takeSummaries()).toEqual([])

    clock += 10 * 60_000
    const summaries = limiter.takeSummaries()
    expect(summaries).toHaveLength(1)
    const embed = (summaries[0]?.embeds as Array<Record<string, unknown>>)[0]
    expect(embed?.['title']).toBe('✗ 142 more failed runs · transcript-summary-discord')
    expect(JSON.stringify(embed?.['fields'])).toContain('output_delivery_exhausted × 142')
    expect(JSON.stringify(embed?.['fields'])).toContain('jr-4')
    expect(JSON.stringify(embed?.['fields'])).toContain('jr-145')
    expect(limiter.takeSummaries()).toEqual([])
    // A new window admits individual cards again.
    expect(limiter.admit(failedEvent(200))).toBe(true)
  })

  test('limits each job separately and never limits started or succeeded cards', () => {
    const limiter = new JobRunFailureCardLimiter({ now: () => 0 })
    for (let i = 0; i < 3; i += 1) {
      expect(limiter.admit(failedEvent(i, 'job-a'))).toBe(true)
    }
    expect(limiter.admit(failedEvent(10, 'job-a'))).toBe(false)
    expect(limiter.admit(failedEvent(11, 'job-b'))).toBe(true)
    expect(limiter.admit(dispatchedEvent())).toBe(true)
    expect(
      limiter.admit({
        ...failedEvent(12, 'job-a'),
        payload: { ...failedEvent(12, 'job-a').payload, status: 'succeeded' },
      })
    ).toBe(true)
  })

  test('pollSystemEventsOnce posts capped failure cards and flushes the summary on a later poll', async () => {
    const channel = new FakeChannel('chan-job-runs')
    const client = new FakeClient()
    client.add(channel)
    let batch: unknown[] = Array.from({ length: 20 }, (_, i) => failedEvent(i + 1))
    const fetchImpl = async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ events: batch }),
        text: async () => '',
      }) as unknown as Response
    let clock = 0
    const app = new GatewayDiscordApp({
      acpBaseUrl: 'http://acp.local',
      gatewayId: 'g',
      client: client as never,
      fetchImpl: fetchImpl as never,
      jobRunsChannelId: 'chan-job-runs',
      jobRunFailureCardLimiter: new JobRunFailureCardLimiter({ now: () => clock }),
    })

    await app.pollSystemEventsOnce()
    const webhook = [...channel.webhooks.values()][0]
    expect(webhook?.sends).toHaveLength(3)

    batch = []
    clock += 10 * 60_000
    await app.pollSystemEventsOnce()
    expect(webhook?.sends).toHaveLength(4)
    const embed = (webhook?.sends[3]?.['embeds'] as Array<Record<string, unknown>>)[0]
    expect(embed?.['title']).toBe('✗ 17 more failed runs · transcript-summary-discord')
  })
})
