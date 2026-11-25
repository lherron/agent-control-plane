import { describe, expect, test } from 'bun:test'
import { adaptWrkqWebhookEvent } from 'acp-core'
import { createInMemoryJobsStore } from 'acp-jobs-store'
import { createEventJobEvaluator } from '../jobs/event-job-evaluator.js'

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

function insertHrcEvent(
  store: ReturnType<typeof createInMemoryJobsStore>,
  input: {
    eventId: string
    eventSeq: number
    origin: { actor: string; kind: string; causation_ref?: string | undefined }
    runtimeId?: string | undefined
  }
) {
  const runtimeId = input.runtimeId ?? 'runtime-42'
  const tripEventId = input.eventId.slice(input.eventId.lastIndexOf(':') + 1)
  const payload = {
    schema_version: 1,
    source: 'hrc',
    event_id: input.eventId,
    canonical_event_id: `hrc:${input.eventId}`,
    event_seq: input.eventSeq,
    event: 'first_turn_missing',
    occurred_at: '2026-08-14T20:00:00Z',
    subject: { type: 'hrc-runtime', id: runtimeId },
    origin: input.origin,
    payload: {
      nodeId: 'max3',
      runtimeId,
      scopeRef: 'agent:cody:project:agent-control-plane:task:T-07237',
      generation: 3,
      invocationId: 'invocation-42',
      runId: 'run-42',
      tripEventId,
      retrievalHint: `hrc runtime diagnostics ${tripEventId}`,
    },
  }
  return store.insertInboxEvent({
    eventId: input.eventId,
    eventSeq: input.eventSeq,
    source: 'hrc',
    event: 'first_turn_missing',
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

describe('event job origin policy evaluator', () => {
  test('hrc agent origins require explicit allow while system:hrc uses the default policy', () => {
    const store = createInMemoryJobsStore()
    const defaultPolicy = store.createJob({
      agentId: 'cody',
      projectId: 'agent-control-plane',
      scopeRef: 'agent:cody:project:agent-control-plane:task:primary',
      trigger: { kind: 'event', source: 'hrc', match: { event: 'first_turn_missing' } },
      input: { content: '{{payload.retrievalHint}}' },
    }).job
    const explicitAllow = store.createJob({
      agentId: 'cody',
      projectId: 'agent-control-plane',
      scopeRef: 'agent:cody:project:agent-control-plane:task:primary',
      trigger: {
        kind: 'event',
        source: 'hrc',
        match: { event: 'first_turn_missing' },
        originPolicy: { agent: 'allow' },
      },
      input: { content: '{{payload.retrievalHint}}' },
    }).job
    const evaluator = createEventJobEvaluator()
    const agentEvent = insertHrcEvent(store, {
      eventId: 'max3:45',
      eventSeq: 1,
      origin: { actor: 'agent:cody', kind: 'agent' },
    })

    expect(evaluator({ job: defaultPolicy, event: agentEvent, store })).toEqual({
      decision: 'skip',
      reason: 'agent_origin_blocked',
    })
    expect(evaluator({ job: explicitAllow, event: agentEvent, store }).decision).toBe('mint')

    const systemEvent = insertHrcEvent(store, {
      eventId: 'max3:46',
      eventSeq: 2,
      origin: { actor: 'system:hrc', kind: 'system' },
    })
    expect(evaluator({ job: defaultPolicy, event: systemEvent, store }).decision).toBe('mint')
  })

  test.each([
    {
      name: 'default denies an agent',
      input: { jobAgentId: 'scribe', origin: { actor: 'agent:mable' } },
      expected: { decision: 'skip', reason: 'agent_origin_blocked' },
    },
    {
      name: 'deny-self blocks same agent',
      input: {
        jobAgentId: 'scribe',
        originPolicy: { agent: 'deny-self' as const },
        origin: { actor: 'agent:scribe' },
      },
      expected: { decision: 'skip', reason: 'agent_origin_blocked' },
    },
    {
      name: 'deny-self blocks inexact agent scope',
      input: {
        jobAgentId: 'scribe',
        originPolicy: { agent: 'deny-self' as const },
        origin: { actor: 'agent:mable:project:taskboard' },
      },
      expected: { decision: 'skip', reason: 'agent_origin_blocked' },
    },
    {
      name: 'deny-self allows other agent',
      input: {
        jobAgentId: 'scribe',
        originPolicy: { agent: 'deny-self' as const },
        origin: { actor: 'agent:mable' },
      },
      expected: { decision: 'mint' },
    },
    {
      name: 'deny-self blocks actorless agent',
      input: {
        jobAgentId: 'scribe',
        originPolicy: { agent: 'deny-self' as const },
        origin: { kind: 'agent' },
      },
      expected: { decision: 'skip', reason: 'agent_origin_blocked' },
    },
    {
      name: 'explicit deny blocks an agent',
      input: {
        jobAgentId: 'scribe',
        originPolicy: { agent: 'deny' as const },
        origin: { actor: 'agent:mable' },
      },
      expected: { decision: 'skip', reason: 'agent_origin_blocked' },
    },
    {
      name: 'allow permits same agent',
      input: {
        jobAgentId: 'scribe',
        originPolicy: { agent: 'allow' as const },
        origin: { actor: 'agent:scribe' },
      },
      expected: { decision: 'mint' },
    },
  ])('agent-origin policy: $name', ({ input, expected }) => {
    expect(evaluateEventOriginPolicy(input)).toMatchObject(expected)
  })
})

describe('event job causation-chain evaluator', () => {
  test('hrc bare job-run causation refs walk while opaque refs degrade benignly', () => {
    const store = createInMemoryJobsStore()
    const job = store.createJob({
      agentId: 'cody',
      projectId: 'agent-control-plane',
      scopeRef: 'agent:cody:project:agent-control-plane:task:primary',
      trigger: {
        kind: 'event',
        source: 'hrc',
        match: { event: 'first_turn_missing' },
        originPolicy: { agent: 'allow' },
      },
      input: { content: '{{payload.retrievalHint}}' },
    }).job
    const causalRun = store.appendJobRun({
      jobId: job.jobId,
      triggeredAt: '2026-08-14T19:59:00Z',
      triggeredBy: 'webhook',
      status: 'dispatched',
      source: {
        kind: 'webhook',
        source: 'hrc',
        eventId: 'max3:41',
        canonicalEventId: 'hrc:max3:41',
        eventSeq: 41,
      },
    }).jobRun
    const evaluator = createEventJobEvaluator()
    const liveRef = insertHrcEvent(store, {
      eventId: 'max3:47',
      eventSeq: 42,
      origin: {
        actor: 'agent:cody',
        kind: 'agent',
        causation_ref: causalRun.jobRunId,
      },
    })
    expect(evaluator({ job, event: liveRef, store })).toEqual({
      decision: 'skip',
      reason: 'causation_cycle',
    })

    const opaqueRef = insertHrcEvent(store, {
      eventId: 'max3:48',
      eventSeq: 43,
      origin: {
        actor: 'agent:cody',
        kind: 'agent',
        causation_ref: 'opaque-unknown-token',
      },
    })
    expect(evaluator({ job, event: opaqueRef, store }).decision).toBe('mint')
  })

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
