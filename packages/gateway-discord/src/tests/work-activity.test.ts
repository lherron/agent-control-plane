import { describe, expect, test } from 'bun:test'

import { GatewayDiscordApp } from '../app.js'
import {
  type WorkActivitySystemEvent,
  buildWorkActivityCard,
  isWorkActivityKind,
} from '../work-activity.js'

function taskUpdated(overrides: Partial<WorkActivitySystemEvent> = {}): WorkActivitySystemEvent {
  return {
    eventId: '20',
    kind: 'wrkq.updated',
    projectId: 'agent-control-plane',
    occurredAt: '2026-06-28T09:59:00.000Z',
    payload: {
      canonicalEventId: 'wrkq:evt-1',
      event: 'updated',
      ticket_id: 'T-05270',
      slug: 'wrkq-wrkf-discord-cards',
      state: 'in_progress',
      transition: { from: 'open', to: 'in_progress' },
      origin: { actor: 'agent:cody', via: 'wrkq' },
    },
    ...overrides,
  }
}

function workflowTransitioned(): WorkActivitySystemEvent {
  return {
    eventId: '21',
    kind: 'wrkf.workflow_transitioned',
    projectId: 'agent-control-plane',
    occurredAt: '2026-06-28T09:58:00.000Z',
    payload: {
      canonicalEventId: 'wrkq:wfe-1',
      event: 'workflow_transitioned',
      ticket_id: 'T-05270',
      slug: 'wrkq-wrkf-discord-cards',
      transition: { from: 'triage', to: 'build' },
      workflow: { instance_id: 'wf-1', outcome: 'review_complete', to: { status: 'build' } },
      origin: { actor: 'agent:smokey', via: 'wrkf', run_id: 'run-xyz' },
    },
  }
}

// Required test #8: card builders.
describe('buildWorkActivityCard (T-05270)', () => {
  test('renders the from -> to arrow as the title hero for a state transition', () => {
    const card = buildWorkActivityCard(taskUpdated())
    const embed = card?.embeds?.[0]
    expect(embed?.title).toBe('◆ open → in_progress · T-05270 wrkq-wrkf-discord-cards')
    expect(embed?.color).toBe(0xe0a23c) // amber = in_progress
    expect(embed?.description).toBe('-# by cody · wrkq')
    expect(card?.username).toBe('cody · wrkq')
  })

  test('non-state updates fall back to a neutral updated line', () => {
    const card = buildWorkActivityCard(
      taskUpdated({ payload: { ticket_id: 'T-1', slug: 'x', changed: ['title'] } })
    )
    expect(card?.embeds?.[0]?.title).toBe('◆ updated · T-1 x')
    expect(card?.embeds?.[0]?.color).toBe(0x7c8595) // neutral slate
  })

  test('comment card uses violet and the comment glyph', () => {
    const card = buildWorkActivityCard(
      taskUpdated({
        kind: 'wrkq.comment_added',
        payload: { ticket_id: 'T-1', slug: 'x', origin: { actor: 'human:lance' } },
      })
    )
    expect(card?.embeds?.[0]?.title).toBe('❝ comment · T-1 x')
    expect(card?.embeds?.[0]?.color).toBe(0xa78bfa)
    expect(card?.username).toBe('lance · wrkq')
  })

  test('workflow transition shows outcome + run id and is colored by the to-status', () => {
    const card = buildWorkActivityCard(workflowTransitioned())
    const embed = card?.embeds?.[0]
    expect(embed?.title).toBe(
      '⟶ triage → build · T-05270 wrkq-wrkf-discord-cards (review_complete)'
    )
    expect(embed?.description).toBe('-# by smokey · wrkf · run run-xyz')
    expect(card?.username).toBe('smokey · wrkf')
  })

  test('workflow attached uses teal and names the template', () => {
    const card = buildWorkActivityCard({
      eventId: '22',
      kind: 'wrkf.workflow_attached',
      projectId: 'p',
      occurredAt: 'x',
      payload: {
        ticket_id: 'T-1',
        slug: 'x',
        workflow: { template: 'triage-v1', state: { status: 'triage' } },
        origin: { actor: 'system' },
      },
    })
    expect(card?.embeds?.[0]?.title).toBe('⚙ workflow attached · T-1 x [triage-v1]')
    expect(card?.embeds?.[0]?.color).toBe(0x14b8a6)
  })

  test('tolerates missing optional fields without throwing', () => {
    const card = buildWorkActivityCard({
      eventId: '23',
      kind: 'wrkq.created',
      projectId: 'p',
      occurredAt: 'x',
      payload: {},
    })
    expect(card?.embeds?.[0]?.title).toBe('✦ created · —')
    expect(card?.username).toBe('system · wrkq')
  })

  test('returns undefined for non work-activity kinds', () => {
    expect(buildWorkActivityCard({ ...taskUpdated(), kind: 'job.dispatched' })).toBeUndefined()
    expect(isWorkActivityKind('job.completed')).toBe(false)
    expect(isWorkActivityKind('wrkq.created')).toBe(true)
    expect(isWorkActivityKind('wrkf.workflow_attached')).toBe(true)
  })
})

// --- Fakes for the dispatch test (mirror job-runs.test.ts) ---
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

function fakeFetchReturning(events: unknown[], requestedUrls: string[]) {
  return async (input: unknown) => {
    requestedUrls.push(String(input))
    return {
      ok: true,
      status: 200,
      json: async () => ({ events }),
      text: async () => '',
    } as unknown as Response
  }
}

const MIXED_EVENTS = [
  {
    eventId: '30',
    kind: 'job.dispatched',
    projectId: 'p',
    occurredAt: 'x',
    payload: { agentId: 'clod', jobRunId: 'jr-1', jobSlug: 's' },
  },
  taskUpdated({ eventId: '31' }),
  workflowTransitioned(),
  { eventId: '40', kind: 'input.started', projectId: 'p', occurredAt: 'x', payload: {} },
]

describe('GatewayDiscordApp system-events dispatch (T-05270)', () => {
  // Required test #6 + #7.
  test('routes job.* to job-runs and wrkq/wrkf to work-activity, one global cursor', async () => {
    const jobRuns = new FakeChannel('chan-job-runs')
    const workActivity = new FakeChannel('chan-work-activity')
    const client = new FakeClient()
    client.add(jobRuns)
    client.add(workActivity)

    const requestedUrls: string[] = []
    const app = new GatewayDiscordApp({
      acpBaseUrl: 'http://acp.local',
      gatewayId: 'g',
      client: client as never,
      fetchImpl: fakeFetchReturning(MIXED_EVENTS, requestedUrls) as never,
      jobRunsChannelId: 'chan-job-runs',
      workActivityChannelId: 'chan-work-activity',
    })

    const seen = await app.pollSystemEventsOnce()
    expect(seen).toBe(4)

    // job.* → job-runs only (1 card); wrkq.*/wrkf.* → work-activity only (2 cards).
    expect([...jobRuns.webhooks.values()][0]?.sends).toHaveLength(1)
    expect([...workActivity.webhooks.values()][0]?.sends).toHaveLength(2)

    // Single global cursor advanced past the highest id (incl. the unrelated kind).
    expect(requestedUrls[0]).toContain('afterEventId=0')
    await app.pollSystemEventsOnce()
    expect(requestedUrls[1]).toContain('afterEventId=40')
  })

  // Required test #9 (gateway half): work-activity unset disables only wrkq/wrkf.
  test('unset work-activity channel disables wrkq/wrkf cards but not job-runs', async () => {
    const jobRuns = new FakeChannel('chan-job-runs')
    const client = new FakeClient()
    client.add(jobRuns)

    const requestedUrls: string[] = []
    const app = new GatewayDiscordApp({
      acpBaseUrl: 'http://acp.local',
      gatewayId: 'g',
      client: client as never,
      fetchImpl: fakeFetchReturning(MIXED_EVENTS, requestedUrls) as never,
      jobRunsChannelId: 'chan-job-runs',
      // workActivityChannelId intentionally unset
    })

    const seen = await app.pollSystemEventsOnce()
    expect(seen).toBe(4) // still advances the cursor across every event
    expect([...jobRuns.webhooks.values()][0]?.sends).toHaveLength(1) // job card still posts
    // wrkq/wrkf events were skipped (no work-activity channel), cursor still advanced.
    await app.pollSystemEventsOnce()
    expect(requestedUrls[1]).toContain('afterEventId=40')
  })
})
