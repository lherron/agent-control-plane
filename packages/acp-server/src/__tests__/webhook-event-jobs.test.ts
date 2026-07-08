import { describe, expect, test } from 'bun:test'

import { createInMemoryAdminStore } from 'acp-admin-store'
import { adaptWrkqWebhookEvent } from 'acp-core'
import { createInMemoryJobsStore } from 'acp-jobs-store'

import type { Actor } from 'acp-core'
import type { ResolvedAcpServerDeps } from '../deps.js'
import { handleCreateAdminJob, handlePatchAdminJob } from '../handlers/admin-jobs.js'
import { handleAcpEventWebhook } from '../handlers/webhooks-events.js'
import { handleWrkqWebhook } from '../handlers/webhooks-wrkq.js'
import { errorResponse } from '../http.js'
import { createEventJobEvaluator } from '../jobs/event-job-evaluator.js'

const ACTOR: Actor = { kind: 'system', id: 'test' }

function makeDeps(options: { jobsStore?: boolean } = {}) {
  const adminStore = createInMemoryAdminStore()
  const jobsStore = options.jobsStore === false ? undefined : createInMemoryJobsStore()
  const deps = {
    adminStore,
    ...(jobsStore !== undefined ? { jobsStore } : {}),
    defaultActor: ACTOR,
  } as unknown as ResolvedAcpServerDeps
  return { adminStore, jobsStore, deps }
}

function jsonRequest(method: string, path: string, body: unknown): Request {
  return new Request(`http://acp.local${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function call(
  handler: (ctx: {
    request: Request
    url: URL
    params: Record<string, string>
    deps: ResolvedAcpServerDeps
    actor: Actor | undefined
  }) => Response | Promise<Response>,
  request: Request,
  deps: ResolvedAcpServerDeps,
  params: Record<string, string> = {}
): Promise<Response> {
  try {
    return await handler({ request, url: new URL(request.url), params, deps, actor: ACTOR })
  } catch (error) {
    return errorResponse(error)
  }
}

const EVENT_JOB_BODY = {
  agentId: 'clod',
  projectId: 'acp',
  scopeRef: 'agent:clod:project:{{project_scope_id}}:task:{{ticket_id}}',
  trigger: {
    kind: 'event',
    source: 'wrkq',
    match: { event: 'created', transition: { to: 'idea' } },
  },
  input: { content: 'Research {{ticket_id}}' },
}

const GUARDED_EVENT_FLOW = {
  sequence: [
    {
      id: 'create_task',
      kind: 'wrkq-task',
      title: 'Investigate {{ticket_id}}',
      container: 'agent-control-plane/inbox',
      description: 'Created from {{event}}.',
    },
    {
      id: 'dispatch',
      kind: 'agent-dispatch',
      scopeRef: 'agent:clod:project:agent-control-plane:task:primary',
      input: { content: 'Handle {{ticket_id}}.' },
    },
  ],
}

function evaluateEventOriginPolicy(input: {
  jobAgentId?: string
  originPolicy?: { agent: 'deny' | 'deny-self' | 'allow' }
  origin?: Record<string, unknown> | undefined
}) {
  const store = createInMemoryJobsStore()
  const jobAgentId = input.jobAgentId ?? 'scribe'
  const { job } = store.createJob({
    agentId: jobAgentId,
    projectId: 'agent-spaces',
    scopeRef: `agent:${jobAgentId}:project:agent-spaces:task:T-1`,
    trigger: {
      kind: 'event',
      source: 'wrkq',
      match: { event: 'created' },
      ...(input.originPolicy !== undefined ? { originPolicy: input.originPolicy } : {}),
    },
    input: { content: 'Render T-1' },
  })
  const payload =
    input.origin !== undefined && input.origin['actor'] === undefined
      ? {
          schema_version: 1,
          source: 'wrkq',
          event_id: 'evt_1',
          canonical_event_id: 'wrkq:evt_1',
          event_seq: 1,
          event: 'created',
          occurred_at: '2026-07-08T00:00:00Z',
          origin: input.origin,
          payload: {},
        }
      : adaptWrkqWebhookEvent({
          schema_version: 2,
          event_id: 'evt_1',
          event_seq: 1,
          event: 'created',
          occurred_at: '2026-07-08T00:00:00Z',
          origin: { actor: String(input.origin?.['actor'] ?? 'human:lance') },
          ticket_id: 'T-1',
          project_scope_id: 'agent-spaces',
        })
  const { event } = store.insertInboxEvent({
    eventId: 'evt_1',
    eventSeq: 1,
    source: 'wrkq',
    event: 'created',
    payload,
  })
  return createEventJobEvaluator()({ job, event, store })
}

function createAllowEventJob(
  store: ReturnType<typeof createInMemoryJobsStore>,
  input: { slug: string; agentId: string }
) {
  return store.createJob({
    slug: input.slug,
    agentId: input.agentId,
    projectId: 'agent-spaces',
    scopeRef: `agent:${input.agentId}:project:agent-spaces:task:T-1`,
    trigger: {
      kind: 'event',
      source: 'wrkq',
      match: { event: 'created' },
      originPolicy: { agent: 'allow' },
    },
    input: { content: 'Render T-1' },
  }).job
}

function wrkqCreatedPayload(input: {
  eventId: string
  eventSeq: number
  causationRef?: string | undefined
}) {
  return adaptWrkqWebhookEvent({
    schema_version: 2,
    event_id: input.eventId,
    event_seq: input.eventSeq,
    event: 'created',
    occurred_at: '2026-07-08T00:00:00Z',
    origin: {
      actor: 'agent:hook-author',
      ...(input.causationRef !== undefined ? { causation_ref: input.causationRef } : {}),
    },
    ticket_id: 'T-1',
    project_scope_id: 'agent-spaces',
  })
}

function insertWrkqEvent(
  store: ReturnType<typeof createInMemoryJobsStore>,
  input: { eventId: string; eventSeq: number; causationRef?: string | undefined }
) {
  const payload = wrkqCreatedPayload(input)
  return store.insertInboxEvent({
    eventId: input.eventId,
    eventSeq: input.eventSeq,
    source: 'wrkq',
    event: 'created',
    payload,
  }).event
}

function appendWebhookRun(
  store: ReturnType<typeof createInMemoryJobsStore>,
  input: { jobId: string; eventId: string; eventSeq: number; jobRunId?: string | undefined }
) {
  return store.appendJobRun({
    jobId: input.jobId,
    triggeredAt: `2026-07-08T00:00:0${input.eventSeq}.000Z`,
    triggeredBy: 'webhook',
    status: 'dispatched',
    source: {
      kind: 'webhook',
      source: 'wrkq',
      eventId: input.eventId,
      canonicalEventId: `wrkq:${input.eventId}`,
      eventSeq: input.eventSeq,
    },
    ...(input.jobRunId !== undefined ? { jobRunId: input.jobRunId } : {}),
  }).jobRun
}

describe('admin jobs trigger union', () => {
  test('creates an event-triggered job', async () => {
    const { deps } = makeDeps()
    const res = await call(
      handleCreateAdminJob,
      jsonRequest('POST', '/v1/admin/jobs', EVENT_JOB_BODY),
      deps
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as { job: { trigger: { kind: string } } }
    expect(body.job.trigger.kind).toBe('event')
  })

  test('creates a non-flow event job with output webhook config', async () => {
    const { deps } = makeDeps()
    const res = await call(
      handleCreateAdminJob,
      jsonRequest('POST', '/v1/admin/jobs', {
        ...EVENT_JOB_BODY,
        output: {
          sinks: [
            { kind: 'webhook', url: 'http://127.0.0.1:18551/api', format: 'discord_markdown' },
          ],
        },
      }),
      deps
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as { job: { output?: { sinks?: Array<{ url: string }> } } }
    expect(body.job.output?.sinks?.[0]?.url).toBe('http://127.0.0.1:18551/api')
  })

  test('rejects non-loopback output webhook URLs', async () => {
    const { deps } = makeDeps()
    const res = await call(
      handleCreateAdminJob,
      jsonRequest('POST', '/v1/admin/jobs', {
        ...EVENT_JOB_BODY,
        output: { sinks: [{ kind: 'webhook', url: 'https://example.com/hook' }] },
      }),
      deps
    )
    expect(res.status).toBe(400)
  })

  test('creates an event-triggered job with a guarded flow', async () => {
    const { deps } = makeDeps()
    const res = await call(
      handleCreateAdminJob,
      jsonRequest('POST', '/v1/admin/jobs', {
        ...EVENT_JOB_BODY,
        flow: GUARDED_EVENT_FLOW,
      }),
      deps
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as { job: { trigger: { kind: string }; flow: unknown } }
    expect(body.job.trigger.kind).toBe('event')
    expect(body.job.flow).toEqual(GUARDED_EVENT_FLOW)
  })

  test('rejects event-triggered flow with authority interpolation', async () => {
    const { deps } = makeDeps()
    const res = await call(
      handleCreateAdminJob,
      jsonRequest('POST', '/v1/admin/jobs', {
        ...EVENT_JOB_BODY,
        flow: {
          sequence: [
            {
              id: 'dispatch',
              kind: 'agent-dispatch',
              scopeRef: 'agent:clod:project:{{payload.project}}:task:primary',
              input: { content: 'x' },
            },
          ],
        },
      }),
      deps
    )
    const body = (await res.json()) as { valid: false; errors: Array<{ code: string }> }
    expect(res.status).toBe(400)
    expect(body.errors.map((error) => error.code)).toContain('authority_field_interpolation')
  })

  test('continues rejecting output config on event-triggered flow jobs', async () => {
    const { deps } = makeDeps()
    const res = await call(
      handleCreateAdminJob,
      jsonRequest('POST', '/v1/admin/jobs', {
        ...EVENT_JOB_BODY,
        flow: GUARDED_EVENT_FLOW,
        output: {
          sinks: [
            { kind: 'webhook', url: 'http://127.0.0.1:18551/api', format: 'discord_markdown' },
          ],
        },
      }),
      deps
    )
    expect(res.status).toBe(400)
  })

  test('allows bolting a guarded flow onto an event job via patch', async () => {
    const { jobsStore, deps } = makeDeps()
    const created = jobsStore.createJob({
      agentId: 'clod',
      projectId: 'acp',
      scopeRef: 'agent:clod:project:{{project_scope_id}}:task:{{ticket_id}}',
      trigger: { kind: 'event', source: 'wrkq', match: { event: 'created' } },
      input: { content: 'x' },
    }).job
    const res = await call(
      handlePatchAdminJob,
      jsonRequest('PATCH', `/v1/admin/jobs/${created.jobId}`, {
        flow: GUARDED_EVENT_FLOW,
      }),
      deps,
      { jobId: created.jobId }
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { job: { flow: unknown } }
    expect(body.job.flow).toEqual(GUARDED_EVENT_FLOW)
  })

  test('allows switching a guarded flow job to an event trigger via patch', async () => {
    const { jobsStore, deps } = makeDeps()
    const created = jobsStore.createJob({
      agentId: 'clod',
      projectId: 'acp',
      scopeRef: 'agent:clod:project:acp:task:primary',
      schedule: { cron: '0 * * * *' },
      input: { content: 'x' },
      flow: GUARDED_EVENT_FLOW,
    }).job
    const res = await call(
      handlePatchAdminJob,
      jsonRequest('PATCH', `/v1/admin/jobs/${created.jobId}`, {
        trigger: { kind: 'event', source: 'wrkq', match: { event: 'created' } },
      }),
      deps,
      { jobId: created.jobId }
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { job: { trigger: { kind: string } } }
    expect(body.job.trigger.kind).toBe('event')
  })

  test('rejects an invalid trigger', async () => {
    const { deps } = makeDeps()
    const res = await call(
      handleCreateAdminJob,
      jsonRequest('POST', '/v1/admin/jobs', {
        ...EVENT_JOB_BODY,
        trigger: { kind: 'event', source: 'Bad Source', match: {} },
      }),
      deps
    )
    expect(res.status).toBe(400)
  })
})

describe('event job origin policy evaluator', () => {
  test('absent policy defaults to deny: all agent-origin events blocked', () => {
    expect(
      evaluateEventOriginPolicy({
        jobAgentId: 'scribe',
        origin: { actor: 'agent:mable' },
      })
    ).toEqual({ decision: 'skip', reason: 'agent_origin_blocked' })
  })

  test('deny-self blocks the same agent', () => {
    expect(
      evaluateEventOriginPolicy({
        jobAgentId: 'scribe',
        originPolicy: { agent: 'deny-self' },
        origin: { actor: 'agent:scribe' },
      })
    ).toEqual({ decision: 'skip', reason: 'agent_origin_blocked' })
  })

  test('deny-self blocks inexact agent actor strings fail-closed', () => {
    expect(
      evaluateEventOriginPolicy({
        jobAgentId: 'scribe',
        originPolicy: { agent: 'deny-self' },
        origin: { actor: 'agent:mable:project:taskboard' },
      })
    ).toEqual({ decision: 'skip', reason: 'agent_origin_blocked' })
  })

  test('deny-self allows other exact agent ids', () => {
    expect(
      evaluateEventOriginPolicy({
        jobAgentId: 'scribe',
        originPolicy: { agent: 'deny-self' },
        origin: { actor: 'agent:mable' },
      }).decision
    ).toBe('mint')
  })

  test("deny-self blocks actorless origin.kind='agent' fail-closed", () => {
    expect(
      evaluateEventOriginPolicy({
        jobAgentId: 'scribe',
        originPolicy: { agent: 'deny-self' },
        origin: { kind: 'agent' },
      })
    ).toEqual({ decision: 'skip', reason: 'agent_origin_blocked' })
  })

  test('explicit deny still blocks all agent-origin events', () => {
    expect(
      evaluateEventOriginPolicy({
        jobAgentId: 'scribe',
        originPolicy: { agent: 'deny' },
        origin: { actor: 'agent:mable' },
      })
    ).toEqual({ decision: 'skip', reason: 'agent_origin_blocked' })
  })

  test('operator allow still permits same-agent origin', () => {
    expect(
      evaluateEventOriginPolicy({
        jobAgentId: 'scribe',
        originPolicy: { agent: 'allow' },
        origin: { actor: 'agent:scribe' },
      }).decision
    ).toBe('mint')
  })
})

describe('event job causation-chain evaluator', () => {
  test('A->B->A skips the second A dispatch with causation_cycle', () => {
    const store = createInMemoryJobsStore()
    const jobA = createAllowEventJob(store, { slug: 'job-a', agentId: 'scribe' })
    const jobB = createAllowEventJob(store, { slug: 'job-b', agentId: 'mable' })
    insertWrkqEvent(store, { eventId: 'evt_a_first', eventSeq: 1 })
    const runA = appendWebhookRun(store, {
      jobId: jobA.jobId,
      eventId: 'evt_a_first',
      eventSeq: 1,
    })
    insertWrkqEvent(store, {
      eventId: 'evt_b_from_a',
      eventSeq: 2,
      causationRef: runA.jobRunId,
    })
    const runB = appendWebhookRun(store, {
      jobId: jobB.jobId,
      eventId: 'evt_b_from_a',
      eventSeq: 2,
    })
    const candidate = insertWrkqEvent(store, {
      eventId: 'evt_a_second',
      eventSeq: 3,
      causationRef: runB.jobRunId,
    })

    expect(createEventJobEvaluator()({ job: jobA, event: candidate, store })).toEqual({
      decision: 'skip',
      reason: 'causation_cycle',
    })
  })

  test('deep linear ancestry skips with causation_depth at N+1', () => {
    const store = createInMemoryJobsStore()
    const candidateJob = createAllowEventJob(store, { slug: 'candidate', agentId: 'scribe' })
    const ancestorJob = createAllowEventJob(store, { slug: 'ancestor', agentId: 'mable' })
    insertWrkqEvent(store, { eventId: 'evt_1', eventSeq: 1 })
    const run1 = appendWebhookRun(store, {
      jobId: ancestorJob.jobId,
      eventId: 'evt_1',
      eventSeq: 1,
    })
    insertWrkqEvent(store, { eventId: 'evt_2', eventSeq: 2, causationRef: run1.jobRunId })
    const run2 = appendWebhookRun(store, {
      jobId: ancestorJob.jobId,
      eventId: 'evt_2',
      eventSeq: 2,
    })
    insertWrkqEvent(store, { eventId: 'evt_3', eventSeq: 3, causationRef: run2.jobRunId })
    const run3 = appendWebhookRun(store, {
      jobId: ancestorJob.jobId,
      eventId: 'evt_3',
      eventSeq: 3,
    })
    const candidate = insertWrkqEvent(store, {
      eventId: 'evt_4',
      eventSeq: 4,
      causationRef: run3.jobRunId,
    })

    expect(
      createEventJobEvaluator({ causationDepthLimit: 2 })({
        job: candidateJob,
        event: candidate,
        store,
      })
    ).toEqual({ decision: 'skip', reason: 'causation_depth' })
  })

  test('unknown forged causation refs are orphaned and evaluate normally', () => {
    const store = createInMemoryJobsStore()
    const job = createAllowEventJob(store, { slug: 'candidate', agentId: 'scribe' })
    const event = insertWrkqEvent(store, {
      eventId: 'evt_unknown',
      eventSeq: 1,
      causationRef: 'jrun_forged_missing',
    })

    expect(createEventJobEvaluator()({ job, event, store }).decision).toBe('mint')
  })

  test('missing source inbox rows end the chain without a skip', () => {
    const store = createInMemoryJobsStore()
    const job = createAllowEventJob(store, { slug: 'candidate', agentId: 'scribe' })
    const ancestor = createAllowEventJob(store, { slug: 'ancestor', agentId: 'mable' })
    const run = appendWebhookRun(store, {
      jobId: ancestor.jobId,
      eventId: 'evt_pruned',
      eventSeq: 1,
    })
    const event = insertWrkqEvent(store, {
      eventId: 'evt_candidate',
      eventSeq: 2,
      causationRef: run.jobRunId,
    })

    expect(createEventJobEvaluator()({ job, event, store }).decision).toBe('mint')
  })

  test('self-referencing store rows terminate via seen-set without crashing', () => {
    const store = createInMemoryJobsStore()
    const job = createAllowEventJob(store, { slug: 'candidate', agentId: 'scribe' })
    const ancestor = createAllowEventJob(store, { slug: 'ancestor', agentId: 'mable' })
    const loopRunId = 'jrun_self_reference'
    insertWrkqEvent(store, {
      eventId: 'evt_loop',
      eventSeq: 1,
      causationRef: loopRunId,
    })
    const run = appendWebhookRun(store, {
      jobRunId: loopRunId,
      jobId: ancestor.jobId,
      eventId: 'evt_loop',
      eventSeq: 1,
    })
    const event = insertWrkqEvent(store, {
      eventId: 'evt_candidate',
      eventSeq: 2,
      causationRef: run.jobRunId,
    })

    expect(createEventJobEvaluator()({ job, event, store }).decision).toBe('mint')
  })
})

describe('POST /v1/webhooks/wrkq', () => {
  const payload = {
    schema_version: 2,
    event_id: 'evt_7',
    event_seq: 7,
    event: 'created',
    occurred_at: '2026-06-07T00:00:00Z',
    origin: { actor: 'human:lance' },
    ticket_id: 'T-1',
    project_scope_id: 'acp',
    transition: { from: null, to: 'idea' },
  }

  test('valid v2 payload → 204 + one durable inbox row; duplicate → 204, no second row', async () => {
    const { jobsStore, deps } = makeDeps()
    const first = await call(
      handleWrkqWebhook,
      jsonRequest('POST', '/v1/webhooks/wrkq', payload),
      deps
    )
    expect(first.status).toBe(204)
    expect(jobsStore.getInboxEvent('wrkq:evt_7').event).toBeDefined()

    const dup = await call(
      handleWrkqWebhook,
      jsonRequest('POST', '/v1/webhooks/wrkq', payload),
      deps
    )
    expect(dup.status).toBe(204)
    const count = jobsStore.sqlite.prepare('SELECT COUNT(*) AS c FROM event_inbox').get() as {
      c: number
    }
    expect(count.c).toBe(1)
  })

  test('unsupported schema_version → 400', async () => {
    const { deps } = makeDeps()
    const res = await call(
      handleWrkqWebhook,
      jsonRequest('POST', '/v1/webhooks/wrkq', { ...payload, schema_version: 1 }),
      deps
    )
    expect(res.status).toBe(400)
  })

  // T-05270: recognized event appends exactly one lifecycle system event.
  test('recognized event appends one wrkq.* system event (observer projection)', async () => {
    const { adminStore, deps } = makeDeps()
    const res = await call(
      handleWrkqWebhook,
      jsonRequest('POST', '/v1/webhooks/wrkq', payload),
      deps
    )
    expect(res.status).toBe(204)
    const rows = adminStore.systemEvents.list({ kind: 'wrkq.created' })
    expect(rows).toHaveLength(1)
    expect((rows[0]?.payload as Record<string, unknown>)['canonicalEventId']).toBe('wrkq:evt_7')
  })

  // Required test #4: jobsStore absent still appends the system event + 204.
  test('jobsStore absent → system event still appended, returns 204', async () => {
    const { adminStore, deps } = makeDeps({ jobsStore: false })
    const res = await call(
      handleWrkqWebhook,
      jsonRequest('POST', '/v1/webhooks/wrkq', payload),
      deps
    )
    expect(res.status).toBe(204)
    expect(adminStore.systemEvents.list({ kind: 'wrkq.created' })).toHaveLength(1)
  })

  // Required test #5: unknown event name still ingested for the inbox but no card.
  test('unknown event name → 204, inbox row written, no lifecycle system event', async () => {
    const { adminStore, jobsStore, deps } = makeDeps()
    const res = await call(
      handleWrkqWebhook,
      jsonRequest('POST', '/v1/webhooks/wrkq', {
        ...payload,
        event: 'snoozed',
        event_id: 'evt_unknown',
      }),
      deps
    )
    expect(res.status).toBe(204)
    expect(jobsStore?.getInboxEvent('wrkq:evt_unknown').event).toBeDefined()
    expect(adminStore.systemEvents.list()).toHaveLength(0)
  })
})

describe('POST /v1/webhooks/events', () => {
  const payload = {
    schema_version: 1,
    source: 'media-ingest',
    event_id: 'evt_transcript_7',
    event_seq: 7,
    event: 'transcript.completed',
    occurred_at: '2026-06-13T00:00:00Z',
    origin: { actor: 'system:media-ingest', kind: 'system' },
    subject: { type: 'transcript', id: 'tr_7' },
    payload: { transcript_id: 'tr_7', backend: 'mlx' },
  }

  test('valid v1 payload → 204 + source-qualified inbox row; duplicate remains 204', async () => {
    const { jobsStore, deps } = makeDeps()
    const first = await call(
      handleAcpEventWebhook,
      jsonRequest('POST', '/v1/webhooks/events', payload),
      deps
    )
    expect(first.status).toBe(204)
    const row = jobsStore.getInboxEvent('media-ingest:evt_transcript_7').event
    expect(row).toBeDefined()
    expect(row?.source).toBe('media-ingest')

    const dup = await call(
      handleAcpEventWebhook,
      jsonRequest('POST', '/v1/webhooks/events', payload),
      deps
    )
    expect(dup.status).toBe(204)
    const count = jobsStore.sqlite.prepare('SELECT COUNT(*) AS c FROM event_inbox').get() as {
      c: number
    }
    expect(count.c).toBe(1)
  })

  test('invalid generic envelope → 400', async () => {
    const { deps } = makeDeps()
    const res = await call(
      handleAcpEventWebhook,
      jsonRequest('POST', '/v1/webhooks/events', { ...payload, source: 'Media Ingest' }),
      deps
    )
    expect(res.status).toBe(400)
  })
})
