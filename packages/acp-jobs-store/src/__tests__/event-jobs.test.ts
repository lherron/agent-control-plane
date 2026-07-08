import { describe, expect, test } from 'bun:test'

import {
  type AcpWebhookEvent,
  adaptWrkqWebhookEvent,
  evaluateEventMatch,
  isAgentOriginEvent,
  parseAcpWebhookEvent,
  parseDurationToMs,
  resolveEventAction,
} from 'acp-core'

import {
  type CreateJobInput,
  type EvaluateEventJob,
  type JobsStore,
  createInMemoryJobsStore,
  tickJobsScheduler,
} from '../index.js'

/** A faithful mirror of acp-server's injected evaluator, kept local to the test. */
const evaluateEventJob: EvaluateEventJob = ({ job, event }) => {
  const trigger = job.trigger
  if (trigger.kind !== 'event') {
    return { decision: 'skip', reason: 'match_false' }
  }
  const parsed = parseAcpWebhookEvent(event.payload)
  if (!parsed.ok) {
    return { decision: 'skip', reason: 'match_false' }
  }
  if (trigger.source !== parsed.event.source) {
    return { decision: 'skip', reason: 'match_false' }
  }
  if (!evaluateEventMatch(trigger.match, parsed.event)) {
    return { decision: 'skip', reason: 'match_false' }
  }
  const agentPolicy = trigger.originPolicy?.agent ?? 'deny'
  if (agentPolicy === 'deny' && isAgentOriginEvent(parsed.event)) {
    return { decision: 'skip', reason: 'agent_origin_blocked' }
  }
  if (agentPolicy === 'deny-self' && isSelfAgentOrigin(parsed.event, job.agentId)) {
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
  const cooldownMs =
    trigger.cooldown !== undefined ? parseDurationToMs(trigger.cooldown) : undefined
  return {
    decision: 'mint',
    resolved: {
      scopeRef: resolved.resolved.scopeRef,
      laneRef: resolved.resolved.laneRef,
      input: resolved.resolved.input,
    },
    source: {
      kind: 'webhook',
      source: parsed.event.source,
      eventId: parsed.event.event_id,
      canonicalEventId: parsed.event.canonical_event_id,
      eventSeq: parsed.event.event_seq,
    },
    targetTaskId: resolved.resolved.targetKey,
    ...(cooldownMs !== undefined ? { cooldownMs } : {}),
  }
}

function isSelfAgentOrigin(
  event: { origin?: { actor?: string; kind?: string } },
  jobAgentId: string
): boolean {
  const actor = event.origin?.actor
  const agentId = typeof actor === 'string' ? /^agent:([^:]+)$/.exec(actor)?.[1] : undefined
  if (agentId !== undefined) {
    return agentId === jobAgentId
  }
  // Fail-closed mirror of the server evaluator: inexact agent actors and
  // actorless kind='agent' events count as self.
  return (typeof actor === 'string' && actor.startsWith('agent:')) || event.origin?.kind === 'agent'
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

const genericEvent = (overrides: Partial<AcpWebhookEvent> = {}): AcpWebhookEvent => ({
  schema_version: 1,
  source: 'media-ingest',
  event_id: 'evt_transcript_1',
  canonical_event_id: 'media-ingest:evt_transcript_1',
  event_seq: 1,
  event: 'transcript.completed',
  occurred_at: '2026-06-13T00:00:00Z',
  origin: { actor: 'system:media-ingest', kind: 'system' },
  subject: { type: 'transcript', id: 'tr_1' },
  payload: { transcript_id: 'tr_1', backend: 'mlx', model_id: 'voxtral' },
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
  const calls: Array<{
    jobRunId: string
    scopeRef: string
    content: string
    causationRef?: string | undefined
  }> = []
  const dispatchThroughInputs = async (input: {
    jobRunId: string
    scopeRef: string
    laneRef: string
    content: string
    causationRef?: string | undefined
  }) => {
    calls.push({
      jobRunId: input.jobRunId,
      scopeRef: input.scopeRef,
      content: input.content,
      ...(input.causationRef !== undefined ? { causationRef: input.causationRef } : {}),
    })
    return { inputAttemptId: `ia_${input.jobRunId}`, runId: `run_${input.jobRunId}` }
  }
  return { calls, dispatchThroughInputs }
}

async function ingestAndTick(
  store: JobsStore,
  payload: Readonly<Record<string, unknown>>,
  now = '2026-06-07T01:00:00Z'
) {
  const parsed = parseAcpWebhookEvent(payload)
  const source = parsed.ok ? parsed.event.source : undefined
  store.insertInboxEvent({
    eventId: String(payload['event_id']),
    eventSeq: Number(payload['event_seq']),
    event: String(payload['event']),
    ...(source !== undefined ? { source } : {}),
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
      .get(evt.jobId) as {
      schedule_cron: string | null
      next_fire_at: string | null
      trigger_kind: string
    }
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
  test('duplicate source/event_id does not create a second inbox row', () => {
    const store = createInMemoryJobsStore()
    const first = store.insertInboxEvent({
      eventId: 'evt_9',
      eventSeq: 9,
      source: 'wrkq',
      event: 'created',
      payload: adaptWrkqWebhookEvent(wrkqEvent({ event_id: 'evt_9', event_seq: 9 })),
    })
    const second = store.insertInboxEvent({
      eventId: 'evt_9',
      eventSeq: 9,
      source: 'wrkq',
      event: 'created',
      payload: adaptWrkqWebhookEvent(wrkqEvent({ event_id: 'evt_9', event_seq: 9 })),
    })
    expect(first.inserted).toBe(true)
    expect(second.inserted).toBe(false)
    const count = store.sqlite.prepare('SELECT COUNT(*) AS c FROM event_inbox').get() as {
      c: number
    }
    expect(count.c).toBe(1)
    expect(first.event.eventId).toBe('wrkq:evt_9')
  })

  test('same producer event_id from different sources does not collide', () => {
    const store = createInMemoryJobsStore()
    store.insertInboxEvent({
      eventId: 'evt_shared',
      eventSeq: 1,
      source: 'wrkq',
      event: 'created',
      payload: adaptWrkqWebhookEvent(wrkqEvent({ event_id: 'evt_shared', event_seq: 1 })),
    })
    store.insertInboxEvent({
      eventId: 'evt_shared',
      eventSeq: 1,
      source: 'media-ingest',
      event: 'transcript.completed',
      payload: genericEvent({
        event_id: 'evt_shared',
        canonical_event_id: 'media-ingest:evt_shared',
      }),
    })
    const rows = store.sqlite
      .prepare('SELECT event_id FROM event_inbox ORDER BY event_id ASC')
      .all() as Array<{ event_id: string }>
    expect(rows.map((row) => row.event_id)).toEqual(['media-ingest:evt_shared', 'wrkq:evt_shared'])
  })

  test('claimPending drains by event_seq and marks leased', () => {
    const store = createInMemoryJobsStore()
    store.insertInboxEvent({
      eventId: 'b',
      eventSeq: 2,
      source: 'wrkq',
      event: 'created',
      payload: adaptWrkqWebhookEvent(wrkqEvent({ event_id: 'b', event_seq: 2 })),
    })
    store.insertInboxEvent({
      eventId: 'a',
      eventSeq: 1,
      source: 'wrkq',
      event: 'created',
      payload: adaptWrkqWebhookEvent(wrkqEvent({ event_id: 'a', event_seq: 1 })),
    })
    const claimed = store.claimPendingInboxEvents({
      now: 'now',
      leaseOwner: 'me',
      leaseExpiresAt: 'later',
    })
    expect(claimed.map((e) => e.eventId)).toEqual(['wrkq:a', 'wrkq:b'])
    expect(claimed[0]?.status).toBe('leased')
  })
})

describe('event-claim minting', () => {
  test('one event → two jobs → two distinct JobRuns + two outcome rows + distinct admission keys (check #3)', async () => {
    const store = createInMemoryJobsStore()
    store.createJob(eventJob({ slug: 'job-a' }))
    store.createJob(eventJob({ slug: 'job-b' }))
    const { runs, calls } = await ingestAndTick(store, adaptWrkqWebhookEvent(wrkqEvent()))

    const minted = runs.filter((r) => r.triggeredBy === 'webhook')
    expect(minted).toHaveLength(2)
    const runIds = new Set(minted.map((r) => r.jobRunId))
    expect(runIds.size).toBe(2)
    // distinct admission keys = distinct jobRunId per dispatch
    expect(new Set(calls.map((c) => c.jobRunId)).size).toBe(2)
    // both resolved to the same target session but different runs
    expect(calls.every((c) => c.scopeRef === 'agent:clod:project:acp:task:T-00042')).toBe(true)

    const matches = store.listEventJobMatches({ sourceEventId: 'wrkq:evt_1' }).matches
    expect(matches).toHaveLength(2)
    expect(matches.every((m) => m.outcome === 'minted')).toBe(true)
  })

  test('persists a resolved snapshot + source provenance on the JobRun', async () => {
    const store = createInMemoryJobsStore()
    store.createJob(eventJob())
    const { runs } = await ingestAndTick(store, adaptWrkqWebhookEvent(wrkqEvent()))
    const minted = runs.find((r) => r.triggeredBy === 'webhook')
    expect(minted).toBeDefined()
    const persisted = store.getJobRun(minted!.jobRunId).jobRun
    expect(persisted?.resolvedScopeRef).toBe('agent:clod:project:acp:task:T-00042')
    expect(persisted?.resolvedInput?.['content']).toBe('Research T-00042')
    expect(persisted?.source?.['eventId']).toBe('evt_1')
    expect(persisted?.source?.['kind']).toBe('webhook')
  })

  test('passes WRKQ causation ref source only for webhook-minted dispatches', async () => {
    const store = createInMemoryJobsStore()
    store.createJob(eventJob())
    const { calls } = await ingestAndTick(store, adaptWrkqWebhookEvent(wrkqEvent()))

    expect(calls).toHaveLength(1)
    expect(calls[0]?.causationRef).toBe(calls[0]?.jobRunId)
  })

  test('snapshots job output onto event JobRuns before later job edits', async () => {
    const store = createInMemoryJobsStore()
    const created = store.createJob(
      eventJob({
        output: { sinks: [{ kind: 'webhook', url: 'http://127.0.0.1:18551/original' }] },
      })
    ).job
    const { runs } = await ingestAndTick(store, adaptWrkqWebhookEvent(wrkqEvent()))
    const minted = runs.find((r) => r.triggeredBy === 'webhook')
    expect(minted?.output?.sinks[0]?.url).toBe('http://127.0.0.1:18551/original')

    store.updateJob(created.jobId, {
      output: { sinks: [{ kind: 'webhook', url: 'http://127.0.0.1:18551/changed' }] },
    })

    const persisted = store.getJobRun(minted!.jobRunId).jobRun
    expect(persisted?.output?.sinks[0]?.url).toBe('http://127.0.0.1:18551/original')
  })

  test('the inbox event is marked processed after a tick', async () => {
    const store = createInMemoryJobsStore()
    store.createJob(eventJob())
    await ingestAndTick(store, adaptWrkqWebhookEvent(wrkqEvent()))
    expect(store.getInboxEvent('wrkq:evt_1').event?.status).toBe('processed')
  })

  test('agent-origin policy: default deny blocks, deny-self splits self/cross-agent, allow preserved', async () => {
    const store = createInMemoryJobsStore()
    store.createJob(
      eventJob({
        slug: 'deny-self-same-job',
        trigger: {
          kind: 'event',
          source: 'wrkq',
          match: { event: 'created', transition: { to: 'idea' } },
          originPolicy: { agent: 'deny-self' },
        },
      })
    )
    store.createJob(
      eventJob({
        slug: 'deny-self-other-job',
        agentId: 'scribe',
        scopeRef: 'agent:scribe:project:{{project_scope_id}}:task:{{ticket_id}}',
        trigger: {
          kind: 'event',
          source: 'wrkq',
          match: { event: 'created', transition: { to: 'idea' } },
          originPolicy: { agent: 'deny-self' },
        },
      })
    )
    store.createJob(
      eventJob({
        slug: 'deny-job',
        agentId: 'scribe',
        scopeRef: 'agent:scribe:project:{{project_scope_id}}:task:{{ticket_id}}',
        trigger: {
          kind: 'event',
          source: 'wrkq',
          match: { event: 'created', transition: { to: 'idea' } },
          originPolicy: { agent: 'deny' },
        },
      })
    )
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
    const { runs } = await ingestAndTick(
      store,
      adaptWrkqWebhookEvent(wrkqEvent({ origin: { actor: 'agent:clod' } }))
    )
    expect(runs.filter((r) => r.triggeredBy === 'webhook')).toHaveLength(2)

    const matches = store.listEventJobMatches({ sourceEventId: 'wrkq:evt_1' }).matches
    expect(matches.filter((m) => m.outcome === 'skipped')).toHaveLength(2)
    expect(matches.filter((m) => m.reason === 'agent_origin_blocked')).toHaveLength(2)
  })

  test('template_error on one job does not poison the event for other jobs (check #5)', async () => {
    const store = createInMemoryJobsStore()
    // Bad job: references an undefined structural var in the scopeRef template.
    store.createJob(
      eventJob({ slug: 'bad-job', scopeRef: 'agent:clod:project:{{nope}}:task:{{ticket_id}}' })
    )
    store.createJob(eventJob({ slug: 'good-job' }))
    const { runs } = await ingestAndTick(store, adaptWrkqWebhookEvent(wrkqEvent()))

    expect(runs.filter((r) => r.triggeredBy === 'webhook')).toHaveLength(1)
    const matches = store.listEventJobMatches({ sourceEventId: 'wrkq:evt_1' }).matches
    expect(matches.find((m) => m.outcome === 'skipped')?.reason).toBe('template_error')
    expect(matches.filter((m) => m.outcome === 'minted')).toHaveLength(1)
    // The event still reached every job and is processed.
    expect(store.getInboxEvent('wrkq:evt_1').event?.status).toBe('processed')
  })

  // T-05416: template_error is reserved for template/evaluation decisions.
  // Unexpected evaluator or mint exceptions need a truthful internal_error row.
  test('unexpected evaluation or mint failures record internal_error, not template_error (T-05416 red)', async () => {
    const store = createInMemoryJobsStore()
    store.createJob(eventJob({ slug: 'broken-evaluator-job' }))
    const payload = adaptWrkqWebhookEvent(wrkqEvent())
    const parsed = parseAcpWebhookEvent(payload)
    store.insertInboxEvent({
      eventId: String(payload['event_id']),
      eventSeq: Number(payload['event_seq']),
      event: String(payload['event']),
      ...(parsed.ok ? { source: parsed.event.source } : {}),
      payload,
    })

    await tickJobsScheduler({
      store,
      now: '2026-06-07T00:00:00.000Z',
      evaluateEventJob: () => {
        throw new Error('sqlite busy while minting job run')
      },
    })

    const matches = store.listEventJobMatches({ sourceEventId: 'wrkq:evt_1' }).matches
    expect(matches).toHaveLength(1)
    expect(matches[0]).toMatchObject({
      outcome: 'skipped',
      reason: 'internal_error',
    })
    expect(store.getInboxEvent('wrkq:evt_1').event?.status).toBe('processed')
  })

  test('non-matching job records match_false (no silent skip)', async () => {
    const store = createInMemoryJobsStore()
    store.createJob(
      eventJob({
        slug: 'mismatch',
        trigger: { kind: 'event', source: 'wrkq', match: { event: 'archived' } },
      })
    )
    await ingestAndTick(store, adaptWrkqWebhookEvent(wrkqEvent()))
    const matches = store.listEventJobMatches({ sourceEventId: 'wrkq:evt_1' }).matches
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
    const first = await ingestAndTick(
      store,
      adaptWrkqWebhookEvent(wrkqEvent({ event_id: 'evt_a', event_seq: 1 })),
      '2026-06-07T01:00:00Z'
    )
    expect(first.runs.filter((r) => r.triggeredBy === 'webhook')).toHaveLength(1)

    const second = await ingestAndTick(
      store,
      adaptWrkqWebhookEvent(wrkqEvent({ event_id: 'evt_b', event_seq: 2 })),
      '2026-06-07T01:30:00Z'
    )
    expect(second.runs.filter((r) => r.triggeredBy === 'webhook')).toHaveLength(0)
    const matches = store.listEventJobMatches({ sourceEventId: 'wrkq:evt_b' }).matches
    expect(matches[0]?.reason).toBe('cooldown')
  })

  test('generic targetKey cooldown uses subject type and id', async () => {
    const store = createInMemoryJobsStore()
    store.createJob({
      projectId: 'media-ingest',
      agentId: 'mneme',
      scopeRef: 'agent:mneme:project:media-ingest:task:primary',
      trigger: {
        kind: 'event',
        source: 'media-ingest',
        match: { event: 'transcript.completed', subject: { type: 'transcript' } },
        cooldown: '1h',
      },
      input: { content: 'Transcript {{payload.transcript_id}} completed' },
    })
    const first = await ingestAndTick(store, genericEvent(), '2026-06-13T01:00:00Z')
    expect(first.runs.filter((r) => r.triggeredBy === 'webhook')).toHaveLength(1)

    const second = await ingestAndTick(
      store,
      genericEvent({
        event_id: 'evt_transcript_2',
        canonical_event_id: 'media-ingest:evt_transcript_2',
        event_seq: 2,
      }),
      '2026-06-13T01:30:00Z'
    )
    expect(second.runs.filter((r) => r.triggeredBy === 'webhook')).toHaveLength(0)
    const matches = store.listEventJobMatches({
      sourceEventId: 'media-ingest:evt_transcript_2',
    }).matches
    expect(matches[0]?.reason).toBe('cooldown')
    expect(matches[0]?.targetTaskId).toBe('transcript:tr_1')
  })
})

describe('mint idempotency (drain-retry safe)', () => {
  test('mintEventJobRun for the same (event,job) pair does not double-mint', () => {
    const store = createInMemoryJobsStore()
    const job = store.createJob(eventJob()).job
    const args = {
      sourceEventId: 'wrkq:evt_1',
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
    const first = await ingestAndTick(store, adaptWrkqWebhookEvent(wrkqEvent()))
    expect(first.calls).toHaveLength(1)
    // Duplicate POST: same event_id re-ingested, then tick again.
    const second = await ingestAndTick(store, adaptWrkqWebhookEvent(wrkqEvent()))
    expect(second.calls).toHaveLength(0)
    const matches = store.listEventJobMatches({ sourceEventId: 'wrkq:evt_1' }).matches
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

  test('schedule dispatches do not carry WRKQ causation refs', async () => {
    const store = createInMemoryJobsStore()
    store.createJob({
      projectId: 'acp',
      agentId: 'clod',
      scopeRef: 'agent:clod:project:acp:task:primary',
      schedule: { cron: '*/5 * * * *' },
      input: { content: 'tick' },
    })
    const recorder = makeDispatchRecorder()
    await tickJobsScheduler({
      store,
      now: '2030-01-01T00:02:00Z',
      dispatchThroughInputs: recorder.dispatchThroughInputs,
    })

    expect(recorder.calls).toHaveLength(1)
    expect(recorder.calls[0]?.causationRef).toBeUndefined()
  })
})
