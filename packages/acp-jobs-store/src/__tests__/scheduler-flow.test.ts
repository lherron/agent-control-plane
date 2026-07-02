import { describe, expect, test } from 'bun:test'

import { type ClaimedDueJob, createInMemoryJobsStore, tickJobsScheduler } from '../index.js'

function createFlowJob(store: ReturnType<typeof createInMemoryJobsStore>) {
  return store.createJob({
    agentId: 'larry',
    projectId: 'demo-project',
    scopeRef: 'agent:larry:project:demo-project:task:T-01311:role:implementer',
    laneRef: 'main',
    schedule: { cron: '*/5 * * * *' },
    input: { content: 'legacy content must not dispatch for flow jobs' },
    flow: {
      sequence: [
        { id: 'collect', input: 'collect context' },
        { id: 'implement', input: 'apply change' },
      ],
    },
    disabled: false,
    createdAt: '2026-04-27T23:00:00.000Z',
  }).job
}

function ensureSequenceStepRows(
  store: ReturnType<typeof createInMemoryJobsStore>,
  entry: ClaimedDueJob
) {
  const flow = entry.job.flow
  if (flow === undefined) {
    throw new Error('expected flow job')
  }

  const missing = flow.sequence.filter(
    (step) =>
      store.jobStepRuns.getById(entry.jobRun.jobRunId, 'sequence', step.id, 1).jobStepRun ===
      undefined
  )
  if (missing.length > 0) {
    store.jobStepRuns.insertMany(
      entry.jobRun.jobRunId,
      'sequence',
      missing.map((step) => ({ stepId: step.id, status: 'pending', attempt: 1 }))
    )
  }
}

describe('flow scheduler branch', () => {
  test('routes a due flow job through advanceFlowJobRun instead of legacy dispatch', async () => {
    const store = createInMemoryJobsStore()

    try {
      const job = createFlowJob(store)
      const advancedEntries: ClaimedDueJob[] = []
      let legacyDispatches = 0

      const runs = await tickJobsScheduler({
        store,
        now: '2026-04-27T23:05:00.000Z',
        dispatchThroughInputs: async () => {
          legacyDispatches += 1
          return { inputAttemptId: 'iat_legacy', runId: 'run_legacy' }
        },
        advanceFlowJobRun: async (entry) => {
          advancedEntries.push(entry)
          ensureSequenceStepRows(store, entry)
          return store.updateJobRun(entry.jobRun.jobRunId, {
            status: 'dispatched',
            dispatchedAt: entry.jobRun.triggeredAt,
            leaseOwner: null,
            leaseExpiresAt: null,
          }).jobRun
        },
      })

      expect(runs).toHaveLength(1)
      expect(runs[0]).toEqual(
        expect.objectContaining({
          jobId: job.jobId,
          status: 'dispatched',
        })
      )
      expect(advancedEntries).toHaveLength(1)
      expect(advancedEntries[0]?.job.flow).toEqual(job.flow)
      expect(legacyDispatches).toBe(0)
      expect(
        store.jobStepRuns
          .listByJobRun(runs[0]!.jobRunId)
          .jobStepRuns.map((step) => [step.stepId, step.status])
      ).toEqual([
        ['collect', 'pending'],
        ['implement', 'pending'],
      ])
    } finally {
      store.close()
    }
  })

  test('flow advancement can reconcile an existing partial step state without duplicating rows', async () => {
    const store = createInMemoryJobsStore()

    try {
      createFlowJob(store)
      let capturedEntry: ClaimedDueJob | undefined

      const runs = await tickJobsScheduler({
        store,
        now: '2026-04-27T23:05:00.000Z',
        advanceFlowJobRun: async (entry) => {
          capturedEntry = entry
          ensureSequenceStepRows(store, entry)
          store.jobStepRuns.updateStep(entry.jobRun.jobRunId, 'sequence', 'collect', 1, {
            status: 'running',
            inputAttemptId: 'iat_collect',
            runId: 'run_collect',
            startedAt: entry.jobRun.triggeredAt,
          })
          return store.updateJobRun(entry.jobRun.jobRunId, {
            status: 'dispatched',
            dispatchedAt: entry.jobRun.triggeredAt,
            leaseOwner: null,
            leaseExpiresAt: null,
          }).jobRun
        },
      })

      expect(runs).toHaveLength(1)
      if (capturedEntry === undefined) {
        throw new Error('expected flow scheduler to call advanceFlowJobRun')
      }

      ensureSequenceStepRows(store, capturedEntry)
      expect(store.jobStepRuns.listByJobRun(runs[0]!.jobRunId).jobStepRuns).toEqual([
        expect.objectContaining({
          stepId: 'collect',
          status: 'running',
          inputAttemptId: 'iat_collect',
          runId: 'run_collect',
        }),
        expect.objectContaining({
          stepId: 'implement',
          status: 'pending',
        }),
      ])
    } finally {
      store.close()
    }
  })

  // T-05416: scheduler-level retry semantics must classify transient infra
  // failures without terminalizing the job run, then retry the same run later.
  test('transient flow advance errors keep the run retryable and recover on a later tick (T-05416 red)', async () => {
    const store = createInMemoryJobsStore()

    try {
      const job = createFlowJob(store)
      const attempts: string[] = []

      await tickJobsScheduler({
        store,
        now: '2026-04-27T23:05:00.000Z',
        advanceFlowJobRun: async (entry) => {
          attempts.push(entry.jobRun.jobRunId)
          throw new Error('The operation timed out.')
        },
      })

      const afterTransient = store.listJobRuns(job.jobId).jobRuns[0]
      expect(afterTransient).toMatchObject({
        status: expect.stringMatching(/^(claimed|dispatched)$/),
        errorCode: expect.not.stringMatching(/^flow_advance_failed$/),
        completedAt: undefined,
      })
      expect(hasRetryBackoffMetadata(afterTransient)).toBe(true)

      const recovered = await tickJobsScheduler({
        store,
        now: '2026-04-27T23:06:00.000Z',
        advanceFlowJobRun: async (entry) => {
          attempts.push(entry.jobRun.jobRunId)
          return store.updateJobRun(entry.jobRun.jobRunId, {
            status: 'dispatched',
            dispatchedAt: '2026-04-27T23:06:00.000Z',
            leaseOwner: null,
            leaseExpiresAt: null,
          }).jobRun
        },
      })

      expect(attempts).toEqual([afterTransient?.jobRunId, afterTransient?.jobRunId])
      expect(recovered.at(-1)).toMatchObject({
        jobRunId: afterTransient?.jobRunId,
        status: 'dispatched',
        errorCode: undefined,
      })
    } finally {
      store.close()
    }
  })

  // T-05416: deterministic flow errors are the negative guard; retry
  // classification must not convert validation/expectation bugs into backoff.
  test('deterministic flow advance errors still fail fast without retry metadata (T-05416 red)', async () => {
    const store = createInMemoryJobsStore()

    try {
      const job = createFlowJob(store)

      const runs = await tickJobsScheduler({
        store,
        now: '2026-04-27T23:05:00.000Z',
        advanceFlowJobRun: async () => {
          throw new Error('invalid job flow for job_static_bad_flow')
        },
      })

      expect(runs).toHaveLength(1)
      expect(runs[0]).toMatchObject({
        jobId: job.jobId,
        status: 'failed',
        completedAt: '2026-04-27T23:05:00.000Z',
      })
      expect(runs[0]?.errorCode).not.toMatch(/^retry_/)
      expect(hasRetryBackoffMetadata(runs[0])).toBe(false)
    } finally {
      store.close()
    }
  })

  // T-05416: transient retries are bounded; the final terminal error must
  // preserve the real infra failure instead of replacing it with a generic code.
  test('transient flow advance retries are bounded and final failure preserves the real error chain (T-05416 red)', async () => {
    const store = createInMemoryJobsStore()

    try {
      const job = createFlowJob(store)
      let thrown = 0

      for (const now of [
        '2026-04-27T23:05:00.000Z',
        '2026-04-27T23:06:00.000Z',
        '2026-04-27T23:07:00.000Z',
        '2026-04-27T23:08:00.000Z',
      ]) {
        await tickJobsScheduler({
          store,
          now,
          advanceFlowJobRun: async () => {
            thrown += 1
            const error = new Error(`dispatch gateway returned HTTP 503 on attempt ${thrown}`)
            ;(error as Error & { status?: number }).status = 503
            throw error
          },
        })
      }

      const finalRun = store.listJobRuns(job.jobId).jobRuns[0]
      expect(thrown).toBe(3)
      expect(finalRun).toMatchObject({
        status: 'failed',
        completedAt: '2026-04-27T23:07:00.000Z',
      })
      expect(finalRun?.errorCode).not.toBe('flow_advance_failed')
      expect(finalRun?.errorMessage).toContain('HTTP 503')
      expect(finalRun?.errorMessage).toContain('attempt 3')
    } finally {
      store.close()
    }
  })

  // T-05416: terminal codes produced by the reaper and agent-step timeout path
  // are the non-retryable boundary once scheduler retries exist.
  test('terminal reaper and agent timeout codes are non-retryable retry boundaries (T-05416 red)', async () => {
    const store = createInMemoryJobsStore()

    try {
      const job = createFlowJob(store)
      for (const errorCode of [
        'job_run_max_duration_exceeded',
        'orphaned_by_job_change',
        'stale_claimed_non_flow',
        'agent_step_timeout',
      ]) {
        store.appendJobRun({
          jobId: job.jobId,
          jobRunId: `jrun_non_retryable_${errorCode}`,
          triggeredAt: '2026-04-27T23:00:00.000Z',
          triggeredBy: 'manual',
          status: 'failed',
          errorCode,
          errorMessage: `${errorCode} terminalized this run`,
          completedAt: '2026-04-27T23:01:00.000Z',
          actor: { kind: 'system', id: 'test' },
          actorStamp: 'system:test',
        })
      }
      store.updateJob(job.jobId, { disabled: true })

      const advanced: string[] = []
      await tickJobsScheduler({
        store,
        now: '2026-04-27T23:10:00.000Z',
        advanceFlowJobRun: async (entry) => {
          advanced.push(entry.jobRun.jobRunId)
          throw new Error('non-retryable terminal runs must never be advanced')
        },
      })

      expect(advanced).toEqual([])
      for (const errorCode of [
        'job_run_max_duration_exceeded',
        'orphaned_by_job_change',
        'stale_claimed_non_flow',
        'agent_step_timeout',
      ]) {
        expect(store.getJobRun(`jrun_non_retryable_${errorCode}`).jobRun).toMatchObject({
          status: 'failed',
          errorCode,
          completedAt: '2026-04-27T23:01:00.000Z',
        })
      }
    } finally {
      store.close()
    }
  })
})

function hasRetryBackoffMetadata(run: unknown): boolean {
  if (run === undefined || run === null || typeof run !== 'object') {
    return false
  }

  const record = run as Record<string, unknown>
  return (
    Object.keys(record).some((key) => /retry|backoff|nextAttempt/i.test(key)) ||
    (record['meta'] !== undefined &&
      typeof record['meta'] === 'object' &&
      record['meta'] !== null &&
      Object.keys(record['meta'] as Record<string, unknown>).some((key) =>
        /retry|backoff|nextAttempt/i.test(key)
      ))
  )
}
