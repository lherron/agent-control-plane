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
})
