import { describe, expect, test } from 'bun:test'

import { createInMemoryAdminStore } from 'acp-admin-store'
import type { JobRecord, JobRunRecord, JobsStore } from 'acp-jobs-store'

import { createJobLifecycleEmitter } from '../lifecycle-events.js'

const ACTOR = { kind: 'system', id: 'acp' } as const

function makeJob(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    jobId: 'job-1',
    slug: 'daily-standup',
    projectId: 'agent-control-plane',
    agentId: 'clod',
    scopeRef: 'agent:clod:project:agent-control-plane:task:T-05245',
    laneRef: 'main',
    trigger: { kind: 'schedule', cron: '0 9 * * *' },
    input: { content: 'go' },
    disabled: false,
    actor: ACTOR,
    createdAt: '2026-06-28T00:00:00.000Z',
    updatedAt: '2026-06-28T00:00:00.000Z',
    ...overrides,
  }
}

function makeRun(overrides: Partial<JobRunRecord> = {}): JobRunRecord {
  return {
    jobRunId: 'jr-1',
    jobId: 'job-1',
    triggeredAt: '2026-06-28T09:00:00.000Z',
    triggeredBy: 'schedule',
    status: 'dispatched',
    actor: ACTOR,
    createdAt: '2026-06-28T09:00:00.000Z',
    updatedAt: '2026-06-28T09:00:00.000Z',
    ...overrides,
  }
}

function emitterWith(job: JobRecord) {
  const admin = createInMemoryAdminStore()
  const jobsStore = {
    getJob: (jobId: string) => ({ job: jobId === job.jobId ? job : undefined }),
  } as unknown as JobsStore
  const emitter = createJobLifecycleEmitter({
    systemEvents: admin.systemEvents,
    jobsStore,
    now: () => new Date('2026-06-28T09:00:01.000Z'),
  })
  return { admin, emitter }
}

describe('job lifecycle emitter (T-05245)', () => {
  test('non-flow dispatched run emits exactly one job.dispatched', () => {
    const job = makeJob()
    const { admin, emitter } = emitterWith(job)
    const run = makeRun({
      status: 'dispatched',
      runId: 'run-1',
      inputAttemptId: 'ia-1',
      dispatchedAt: '2026-06-28T09:00:00.500Z',
    })

    emitter.reconcile(run, job)
    emitter.reconcile(run, job) // repeated tick must not double-emit

    const dispatched = admin.systemEvents.list({ kind: 'job.dispatched' })
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0]?.payload).toMatchObject({
      jobRunId: 'jr-1',
      jobSlug: 'daily-standup',
      agentId: 'clod',
      projectId: 'agent-control-plane',
      runId: 'run-1',
      inputAttemptId: 'ia-1',
      triggeredBy: 'schedule',
    })
    expect(admin.systemEvents.list({ kind: 'job.completed' })).toHaveLength(0)
  })

  test('synchronous flow (terminal without observed dispatch) emits both events in order', () => {
    const job = makeJob({ flow: { sequence: [] } as unknown as JobRecord['flow'] })
    const { admin, emitter } = emitterWith(job)
    // Flow raced straight to succeeded; we never saw the 'dispatched' state and
    // there is no top-level runId.
    const run = makeRun({ status: 'succeeded', completedAt: '2026-06-28T09:00:02.000Z' })

    emitter.reconcile(run, job)

    const all = admin.systemEvents.list({})
    expect(all.map((e) => e.kind)).toEqual(['job.dispatched', 'job.completed'])
    // Optional runId/inputAttemptId omitted for flow runs without a top-level run.
    expect(all[0]?.payload['runId']).toBeUndefined()
    expect(all[1]?.payload).toMatchObject({ status: 'succeeded', jobRunId: 'jr-1' })
  })

  test('completion coverage: failed terminal emits one job.completed with error', () => {
    const job = makeJob()
    const { admin, emitter } = emitterWith(job)
    const run = makeRun({
      status: 'failed',
      errorCode: 'dispatch_failed',
      errorMessage: 'boom',
      completedAt: '2026-06-28T09:00:03.000Z',
    })

    emitter.reconcile(run, job)
    emitter.reconcile(run, job) // idempotent over repeated reconciler ticks

    const completed = admin.systemEvents.list({ kind: 'job.completed' })
    expect(completed).toHaveLength(1)
    expect(completed[0]?.payload).toMatchObject({
      status: 'failed',
      errorCode: 'dispatch_failed',
      errorMessage: 'boom',
    })
  })

  test('pending/claimed/skipped runs emit nothing (not yet started)', () => {
    const job = makeJob()
    const { admin, emitter } = emitterWith(job)
    emitter.reconcile(makeRun({ status: 'claimed' }), job)
    emitter.reconcile(makeRun({ status: 'pending' }), job)
    emitter.reconcile(makeRun({ status: 'skipped' }), job)
    expect(admin.systemEvents.list({})).toHaveLength(0)
  })

  test('succeeded completion carries a truncated finalResponse when resolver provided', () => {
    const job = makeJob()
    const admin = createInMemoryAdminStore()
    const jobsStore = {
      getJob: () => ({ job }),
    } as unknown as JobsStore
    const emitter = createJobLifecycleEmitter({
      systemEvents: admin.systemEvents,
      jobsStore,
      resolveFinalText: (runId) => (runId === 'run-1' ? `  ${'y'.repeat(5000)}  ` : undefined),
    })
    emitter.reconcile(makeRun({ status: 'succeeded', runId: 'run-1', completedAt: 'z' }), job)

    const completed = admin.systemEvents.list({ kind: 'job.completed' })[0]
    const finalResponse = completed?.payload['finalResponse'] as string
    expect(finalResponse.length).toBe(3500)
    expect(finalResponse.endsWith('…')).toBe(true)
  })

  test('failed completion and runId-less runs carry no finalResponse', () => {
    const job = makeJob()
    const admin = createInMemoryAdminStore()
    const jobsStore = { getJob: () => ({ job }) } as unknown as JobsStore
    const emitter = createJobLifecycleEmitter({
      systemEvents: admin.systemEvents,
      jobsStore,
      resolveFinalText: () => 'should not appear on failures',
    })
    emitter.reconcile(makeRun({ status: 'failed', runId: 'run-1', completedAt: 'z' }), job)
    emitter.reconcile(makeRun({ jobRunId: 'jr-2', status: 'succeeded', completedAt: 'z' }), job)

    const events = admin.systemEvents.list({ kind: 'job.completed' })
    for (const e of events) {
      expect(e.payload['finalResponse']).toBeUndefined()
    }
  })

  test('resolves the job by id when not passed by the caller', () => {
    const job = makeJob()
    const { admin, emitter } = emitterWith(job)
    emitter.reconcile(makeRun({ status: 'dispatched' }))
    expect(admin.systemEvents.list({ kind: 'job.dispatched' })).toHaveLength(1)
  })
})
