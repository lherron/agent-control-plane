import { describe, expect, test } from 'bun:test'

import { createInMemoryJobsStore, tickJobsScheduler } from '../index.js'

type JobsStore = ReturnType<typeof createInMemoryJobsStore>

function createFlowJob(store: JobsStore, input: { disabled?: boolean | undefined } = {}) {
  return store.createJob({
    agentId: 'larry',
    projectId: 'demo',
    scopeRef: 'agent:larry:project:demo:task:T-05414',
    laneRef: 'main',
    schedule: { cron: '0 4 * * 1' },
    input: { content: 'unused flow input' },
    flow: {
      sequence: [{ id: 'agent-step', input: 'continue the flow' }],
    },
    disabled: input.disabled ?? false,
    createdAt: '2026-04-28T00:00:00.000Z',
  }).job
}

function createNonFlowJob(store: JobsStore, input: { disabled?: boolean | undefined } = {}) {
  return store.createJob({
    agentId: 'larry',
    projectId: 'demo',
    scopeRef: 'agent:larry:project:demo:task:T-05414',
    laneRef: 'main',
    schedule: { cron: '0 4 * * 1' },
    input: { content: 'single-turn job' },
    disabled: input.disabled ?? false,
    createdAt: '2026-04-28T00:00:00.000Z',
  }).job
}

describe('scheduler job-run reaper (T-05414 red)', () => {
  test('finalizes job runs that exceed the configured max duration without advancing the flow', async () => {
    const store = createInMemoryJobsStore()
    try {
      const job = createFlowJob(store)
      const run = store.appendJobRun({
        jobId: job.jobId,
        jobRunId: 'jrun_max_duration',
        triggeredAt: '2026-04-28T00:00:00.000Z',
        triggeredBy: 'manual',
        status: 'dispatched',
        claimedAt: '2026-04-28T00:00:00.000Z',
        dispatchedAt: '2026-04-28T00:00:00.000Z',
        actor: { kind: 'system', id: 'test' },
        actorStamp: 'system:test',
      }).jobRun

      const advanced: string[] = []
      await tickJobsScheduler({
        store,
        now: '2026-04-28T00:02:00.000Z',
        // Red acceptance hook: production should default near 24h, but tests need a
        // short override so the deadline behavior is observable without waiting.
        maxJobRunDurationMs: 60_000,
        advanceFlowJobRun: async (entry) => {
          advanced.push(entry.jobRun.jobRunId)
          return entry.jobRun
        },
      } as Parameters<typeof tickJobsScheduler>[0] & { maxJobRunDurationMs: number })

      expect(advanced).toEqual([])
      expect(store.getJobRun(run.jobRunId).jobRun).toMatchObject({
        status: 'failed',
        errorCode: 'job_run_max_duration_exceeded',
        completedAt: '2026-04-28T00:02:00.000Z',
      })
    } finally {
      store.close()
    }
  })

  test('finalizes inflight flow runs orphaned by archived, disabled, or flow-less jobs', async () => {
    const store = createInMemoryJobsStore()
    try {
      const archived = createFlowJob(store)
      const disabled = createFlowJob(store, { disabled: true })
      const flowless = createNonFlowJob(store)

      const archivedRun = store.appendJobRun({
        jobId: archived.jobId,
        jobRunId: 'jrun_archived_orphan',
        triggeredAt: '2026-04-28T00:00:00.000Z',
        triggeredBy: 'manual',
        status: 'dispatched',
        dispatchedAt: '2026-04-28T00:00:00.000Z',
        actor: { kind: 'system', id: 'test' },
        actorStamp: 'system:test',
      }).jobRun
      const disabledRun = store.appendJobRun({
        jobId: disabled.jobId,
        jobRunId: 'jrun_disabled_orphan',
        triggeredAt: '2026-04-28T00:01:00.000Z',
        triggeredBy: 'manual',
        status: 'dispatched',
        dispatchedAt: '2026-04-28T00:01:00.000Z',
        actor: { kind: 'system', id: 'test' },
        actorStamp: 'system:test',
      }).jobRun
      const flowlessRun = store.appendJobRun({
        jobId: flowless.jobId,
        jobRunId: 'jrun_flowless_orphan',
        triggeredAt: '2026-04-28T00:02:00.000Z',
        triggeredBy: 'manual',
        status: 'dispatched',
        dispatchedAt: '2026-04-28T00:02:00.000Z',
        actor: { kind: 'system', id: 'test' },
        actorStamp: 'system:test',
      }).jobRun
      store.archiveJob(archived.jobId)

      const advanced: string[] = []
      await tickJobsScheduler({
        store,
        now: '2026-04-28T00:05:00.000Z',
        advanceFlowJobRun: async (entry) => {
          advanced.push(entry.jobRun.jobRunId)
          return entry.jobRun
        },
      })

      expect(advanced).toEqual([])
      for (const jobRunId of [archivedRun.jobRunId, disabledRun.jobRunId, flowlessRun.jobRunId]) {
        expect(store.getJobRun(jobRunId).jobRun).toMatchObject({
          status: 'failed',
          errorCode: 'orphaned_by_job_change',
          completedAt: '2026-04-28T00:05:00.000Z',
        })
      }
    } finally {
      store.close()
    }
  })

  test('finalizes stale claimed non-flow runs with a distinct non-retryable code', async () => {
    const store = createInMemoryJobsStore()
    try {
      const job = createNonFlowJob(store, { disabled: true })
      const run = store.appendJobRun({
        jobId: job.jobId,
        jobRunId: 'jrun_stale_claimed_non_flow',
        triggeredAt: '2026-06-01T00:00:00.000Z',
        triggeredBy: 'manual',
        status: 'claimed',
        claimedAt: '2026-06-01T00:00:00.000Z',
        leaseOwner: 'dead-scheduler',
        leaseExpiresAt: '2026-06-01T00:30:00.000Z',
        actor: { kind: 'system', id: 'test' },
        actorStamp: 'system:test',
      }).jobRun

      const dispatched: string[] = []
      await tickJobsScheduler({
        store,
        now: '2026-06-03T00:00:00.000Z',
        dispatchThroughInputs: async (input) => {
          dispatched.push(input.jobRunId)
          return { inputAttemptId: 'iat_unexpected', runId: 'run_unexpected' }
        },
      })

      expect(dispatched).toEqual([])
      expect(store.getJobRun(run.jobRunId).jobRun).toMatchObject({
        status: 'failed',
        errorCode: 'stale_claimed_non_flow',
        completedAt: '2026-06-03T00:00:00.000Z',
      })
    } finally {
      store.close()
    }
  })
})
