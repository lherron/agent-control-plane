import { describe, expect, test } from 'bun:test'

import {
  evaluateEventMatch,
  isAgentOriginEvent,
  parseDurationToMs,
  parseWrkqWebhookEvent,
  resolveEventAction,
} from 'acp-core'

import {
  createInMemoryJobsStore,
  tickJobsScheduler,
  type CreateJobInput,
  type EvaluateEventJob,
  type JobsStore,
} from '../index.js'

/** A faithful mirror of acp-server's injected evaluator, kept local to the test. */
const evaluateEventJob: EvaluateEventJob = ({ job, event }) => {
  const trigger = job.trigger
  if (trigger.kind !== 'event') {
    return { decision: 'skip', reason: 'match_false' }
  }
  const parsed = parseWrkqWebhookEvent(event.payload)
  if (!parsed.ok) {
    return { decision: 'skip', reason: 'match_false' }
  }
  if (!evaluateEventMatch(trigger.match, parsed.event)) {
    return { decision: 'skip', reason: 'match_false' }
  }
  const agentPolicy = trigger.originPolicy?.agent ?? 'deny'
  if (agentPolicy === 'deny' && isAgentOriginEvent(parsed.event)) {
    return { decision: 'skip', reason: 'agent_origin_blocked' }
  }
  const resolved = resolveEventAction({
    scopeRefTemplate: job.scopeRef,
    laneRefTemplate: job.laneRef,
    inputTemplate: job.input,
    event: parsed.event,
  })
  if (!resolved.ok) {
    return { decision: 'skip', reason: 'template_error' }
  }
  const cooldownMs = trigger.cooldown !== undefined ? parseDurationToMs(trigger.cooldown) : undefined
  return {
    decision: 'mint',
    resolved: {
      scopeRef: resolved.resolved.scopeRef,
      laneRef: resolved.resolved.laneRef,
      input: resolved.resolved.input,
    },
    source: { kind: 'webhook', source: 'wrkq', eventId: parsed.event.event_id, eventSeq: parsed.event.event_seq },
    ...(resolved.resolved.targetTaskId !== undefined ? { targetTaskId: resolved.resolved.targetTaskId } : {}),
    ...(cooldownMs !== undefined ? { cooldownMs } : {}),
  }
}

const wrkqEvent = (overrides: Record<string, unknown> = {}) => ({
  schema_version: 2,
  event_id: 'evt_1',
  event_seq: 1,
  event: 'created',
  occurred_at: '2026-06-07T00:00:00Z',
  origin: { actor: 'human:lance', via: 'cli' },
  ticket_id: 'T-00042',
  project_scope_id: 'acp',
  transition: { from: null, to: 'idea' },
  ...overrides,
})

function eventJob(overrides: Partial<CreateJobInput> = {}): CreateJobInput {
  return {
    projectId: 'acp',
    agentId: 'clod',
    scopeRef: 'agent:clod:project:{{project_scope_id}}:task:{{ticket_id}}',
    trigger: {
      kind: 'event',
      source: 'wrkq',
      match: { event: 'created', transition: { to: 'idea' } },
    },
    input: { content: 'Research {{ticket_id}}' },
    ...overrides,
  }
}

function makeDispatchRecorder() {
  const calls: Array<{ jobRunId: string; scopeRef: string; content: string }> = []
  const dispatchThroughInputs = async (input: {
    jobRunId: string
    scopeRef: string
    laneRef: string
    content: string
  }) => {
    calls.push({ jobRunId: input.jobRunId, scopeRef: input.scopeRef, content: input.content })
    return { inputAttemptId: `ia_${input.jobRunId}`, runId: `run_${input.jobRunId}` }
  }
  return { calls, dispatchThroughInputs }
}

async function ingestAndTick(
  store: JobsStore,
  payload: Record<string, unknown>,
  now = '2026-06-07T01:00:00Z'
) {
  store.insertInboxEvent({
    eventId: String(payload['event_id']),
    eventSeq: Number(payload['event_seq']),
    event: String(payload['event']),
    payload,
  })
  const recorder = makeDispatchRecorder()
  const runs = await tickJobsScheduler({
    store,
    now,
    evaluateEventJob,
    dispatchThroughInputs: recorder.dispatchThroughInputs,
  })
  return { runs, calls: recorder.calls }
}

describe('trigger union round-trip', () => {
  test('schedule job keeps schedule; event job has no schedule and null schedule_cron', () => {
    const store = createInMemoryJobsStore()
    const schedule = store.createJob({
      projectId: 'acp',
      agentId: 'clod',
      scopeRef: 'agent:clod:project:acp:task:primary',
      schedule: { cron: '0 * * * *' },
      input: { content: 'tick' },
    }).job
    expect(schedule.trigger.kind).toBe('schedule')
    expect(schedule.schedule?.cron).toBe('0 * * * *')

    const evt = store.createJob(eventJob()).job
    expect(evt.trigger.kind).toBe('event')
    expect(evt.schedule).toBeUndefined()
    const row = store.sqlite
      .prepare('SELECT schedule_cron, next_fire_at, trigger_kind FROM jobs WHERE job_id = ?')
      .get(evt.jobId) as { schedule_cron: string | null; next_fire_at: string | null; trigger_kind: string }
    expect(row.schedule_cron).toBeNull()
    expect(row.next_fire_at).toBeNull()
    expect(row.trigger_kind).toBe('event')
  })
})

describe('schedule-claim footgun (reviewer check #1)', () => {
  test('an event job (next_fire_at NULL) is never claimed by the schedule path', () => {
    const store = createInMemoryJobsStore()
    store.createJob(eventJob())
    store.createJob({
      projectId: 'acp',
      agentId: 'clod',
      scopeRef: 'agent:clod:project:acp:task:primary',
      schedule: { cron: '0 * * * *' },
      input: { content: 'tick' },
    })
    // Far-future now: the schedule job is due, the event job must be ignored.
    const claimed = store.claimDueJobs({ now: '2030-01-01T00:00:00Z' })
    expect(claimed).toHaveLength(1)
    expect(claimed[0]?.job.trigger.kind).toBe('schedule')
  })
})

describe('event_inbox idempotency', () => {
  test('duplicate event_id does not create a second inbox row', () => {
    const store = createInMemoryJobsStore()
    const first = store.insertInboxEvent({ eventId: 'evt_9', eventSeq: 9, event: 'created', payload: wrkqEvent({ event_id: 'evt_9', event_seq: 9 }) })
    const second = store.insertInboxEvent({ eventId: 'evt_9', eventSeq: 9, event: 'created', payload: wrkqEvent({ event_id: 'evt_9', event_seq: 9 }) })
    expect(first.inserted).toBe(true)
    expect(second.inserted).toBe(false)
    const count = store.sqlite.prepare('SELECT COUNT(*) AS c FROM event_inbox').get() as { c: number }
    expect(count.c).toBe(1)
  })

  test('claimPending drains by event_seq and marks leased', () => {
    const store = createInMemoryJobsStore()
    store.insertInboxEvent({ eventId: 'b', eventSeq: 2, event: 'created', payload: wrkqEvent({ event_id: 'b', event_seq: 2 }) })
    store.insertInboxEvent({ eventId: 'a', eventSeq: 1, event: 'created', payload: wrkqEvent({ event_id: 'a', event_seq: 1 }) })
    const claimed = store.claimPendingInboxEvents({ now: 'now', leaseOwner: 'me', leaseExpiresAt: 'later' })
    expect(claimed.map((e) => e.eventId)).toEqual(['a', 'b'])
    expect(claimed[0]?.status).toBe('leased')
  })
})

describe('event-claim minting', () => {
  test('one event → two jobs → two distinct JobRuns + two outcome rows + distinct admission keys (check #3)', async () => {
    const store = createInMemoryJobsStore()
    store.createJob(eventJob({ slug: 'job-a' }))
    store.createJob(eventJob({ slug: 'job-b' }))
    const { runs, calls } = await ingestAndTick(store, wrkqEvent())

    const minted = runs.filter((r) => r.triggeredBy === 'webhook')
    expect(minted).toHaveLength(2)
    const runIds = new Set(minted.map((r) => r.jobRunId))
    expect(runIds.size).toBe(2)
    // distinct admission keys = distinct jobRunId per dispatch
    expect(new Set(calls.map((c) => c.jobRunId)).size).toBe(2)
    // both resolved to the same target session but different runs
    expect(calls.every((c) => c.scopeRef === 'agent:clod:project:acp:task:T-00042')).toBe(true)

    const matches = store.listEventJobMatches({ sourceEventId: 'evt_1' }).matches
    expect(matches).toHaveLength(2)
    expect(matches.every((m) => m.outcome === 'minted')).toBe(true)
  })

  test('persists a resolved snapshot + source provenance on the JobRun', async () => {
    const store = createInMemoryJobsStore()
    store.createJob(eventJob())
    const { runs } = await ingestAndTick(store, wrkqEvent())
    const minted = runs.find((r) => r.triggeredBy === 'webhook')
    expect(minted).toBeDefined()
    const persisted = store.getJobRun(minted!.jobRunId).jobRun
    expect(persisted?.resolvedScopeRef).toBe('agent:clod:project:acp:task:T-00042')
    expect(persisted?.resolvedInput?.['content']).toBe('Research T-00042')
    expect(persisted?.source?.['eventId']).toBe('evt_1')
    expect(persisted?.source?.['kind']).toBe('webhook')
  })

  test('the inbox event is marked processed after a tick', async () => {
    const store = createInMemoryJobsStore()
    store.createJob(eventJob())
    await ingestAndTick(store, wrkqEvent())
    expect(store.getInboxEvent('evt_1').event?.status).toBe('processed')
  })

  test('agent-origin event is blocked by default; opt-in mints (check #4)', async () => {
    const store = createInMemoryJobsStore()
    store.createJob(eventJob({ slug: 'deny-job' }))
    store.createJob(
      eventJob({
        slug: 'allow-job',
        trigger: {
          kind: 'event',
          source: 'wrkq',
          match: { event: 'created', transition: { to: 'idea' } },
          originPolicy: { agent: 'allow' },
        },
      })
    )
    const { runs } = await ingestAndTick(store, wrkqEvent({ origin: { actor: 'agent:clod' } }))
    expect(runs.filter((r) => r.triggeredBy === 'webhook')).toHaveLength(1)

    const matches = store.listEventJobMatches({ sourceEventId: 'evt_1' }).matches
    const blocked = matches.find((m) => m.outcome === 'skipped')
    expect(blocked?.reason).toBe('agent_origin_blocked')
  })

  test('template_error on one job does not poison the event for other jobs (check #5)', async () => {
    const store = createInMemoryJobsStore()
    // Bad job: references an undefined structural var in the scopeRef template.
    store.createJob(
      eventJob({ slug: 'bad-job', scopeRef: 'agent:clod:project:{{nope}}:task:{{ticket_id}}' })
    )
    store.createJob(eventJob({ slug: 'good-job' }))
    const { runs } = await ingestAndTick(store, wrkqEvent())

    expect(runs.filter((r) => r.triggeredBy === 'webhook')).toHaveLength(1)
    const matches = store.listEventJobMatches({ sourceEventId: 'evt_1' }).matches
    expect(matches.find((m) => m.outcome === 'skipped')?.reason).toBe('template_error')
    expect(matches.filter((m) => m.outcome === 'minted')).toHaveLength(1)
    // The event still reached every job and is processed.
    expect(store.getInboxEvent('evt_1').event?.status).toBe('processed')
  })

  test('non-matching job records match_false (no silent skip)', async () => {
    const store = createInMemoryJobsStore()
    store.createJob(
      eventJob({
        slug: 'mismatch',
        trigger: { kind: 'event', source: 'wrkq', match: { event: 'archived' } },
      })
    )
    await ingestAndTick(store, wrkqEvent())
    const matches = store.listEventJobMatches({ sourceEventId: 'evt_1' }).matches
    expect(matches).toHaveLength(1)
    expect(matches[0]?.outcome).toBe('skipped')
    expect(matches[0]?.reason).toBe('match_false')
  })

  test('cooldown backstop blocks a second mint for the same target task', async () => {
    const store = createInMemoryJobsStore()
    store.createJob(
      eventJob({
        slug: 'cooldown-job',
        trigger: {
          kind: 'event',
          source: 'wrkq',
          match: { event: 'created' },
          cooldown: '1h',
        },
      })
    )
    const first = await ingestAndTick(store, wrkqEvent({ event_id: 'evt_a', event_seq: 1 }), '2026-06-07T01:00:00Z')
    expect(first.runs.filter((r) => r.triggeredBy === 'webhook')).toHaveLength(1)

    const second = await ingestAndTick(store, wrkqEvent({ event_id: 'evt_b', event_seq: 2 }), '2026-06-07T01:30:00Z')
    expect(second.runs.filter((r) => r.triggeredBy === 'webhook')).toHaveLength(0)
    const matches = store.listEventJobMatches({ sourceEventId: 'evt_b' }).matches
    expect(matches[0]?.reason).toBe('cooldown')
  })
})

describe('mint idempotency (drain-retry safe)', () => {
  test('mintEventJobRun for the same (event,job) pair does not double-mint', () => {
    const store = createInMemoryJobsStore()
    const job = store.createJob(eventJob()).job
    const args = {
      sourceEventId: 'evt_1',
      eventSeq: 1,
      jobId: job.jobId,
      resolvedScopeRef: 'agent:clod:project:acp:task:T-00042',
      resolvedLaneRef: 'main',
      resolvedInput: { content: 'go' },
      source: { kind: 'webhook' },
      targetTaskId: 'T-00042',
    }
    const first = store.mintEventJobRun(args)
    const second = store.mintEventJobRun(args)
    expect(first.minted).toBe(true)
    expect(second.minted).toBe(false)
    expect(second.jobRun.jobRunId).toBe(first.jobRun.jobRunId)
    const runs = store.listJobRuns(job.jobId).jobRuns
    expect(runs).toHaveLength(1)
  })

  test('re-ticking a duplicate POST does not double-mint or re-dispatch (check #2)', async () => {
    const store = createInMemoryJobsStore()
    store.createJob(eventJob())
    const first = await ingestAndTick(store, wrkqEvent())
    expect(first.calls).toHaveLength(1)
    // Duplicate POST: same event_id re-ingested, then tick again.
    const second = await ingestAndTick(store, wrkqEvent())
    expect(second.calls).toHaveLength(0)
    const matches = store.listEventJobMatches({ sourceEventId: 'evt_1' }).matches
    expect(matches).toHaveLength(1)
  })
})

describe('manual + cron behavior unchanged (check #7)', () => {
  test('claimDueJobs still claims a due schedule job and mints a schedule run', () => {
    const store = createInMemoryJobsStore()
    store.createJob({
      projectId: 'acp',
      agentId: 'clod',
      scopeRef: 'agent:clod:project:acp:task:primary',
      schedule: { cron: '*/5 * * * *' },
      input: { content: 'tick' },
    })
    const claimed = store.claimDueJobs({ now: '2030-01-01T00:02:00Z' })
    expect(claimed).toHaveLength(1)
    expect(['schedule', 'catch-up']).toContain(claimed[0]?.jobRun.triggeredBy)
  })
})
