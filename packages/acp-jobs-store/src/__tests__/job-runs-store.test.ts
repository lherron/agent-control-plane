import { describe, expect, test } from 'bun:test'

import { createInMemoryJobsStore } from '../index.js'

describe('job-runs store contract', () => {
  test('updating a failed run to succeeded with null error fields clears the stale error', () => {
    const store = createInMemoryJobsStore()

    try {
      const { jobRun } = store.appendJobRun({
        jobId: 'job_clear_error',
        jobRunId: 'jrun_clear_error',
        triggeredAt: '2026-04-23T12:00:00.000Z',
        triggeredBy: 'manual',
        status: 'failed',
        errorCode: 'flow_advance_failed',
        errorMessage: 'different request body already exists for idempotencyKey x',
      })

      expect(jobRun.errorCode).toBe('flow_advance_failed')
      expect(jobRun.errorMessage).toContain('idempotencyKey')

      const updated = store.updateJobRun(jobRun.jobRunId, {
        status: 'succeeded',
        errorCode: null,
        errorMessage: null,
        completedAt: '2026-04-23T12:01:00.000Z',
      }).jobRun

      expect(updated.status).toBe('succeeded')
      expect(updated.errorCode).toBeUndefined()
      expect(updated.errorMessage).toBeUndefined()
    } finally {
      store.close()
    }
  })

  test('inserts, gets, updates, and lists job step runs in phase order', () => {
    const store = createInMemoryJobsStore()

    try {
      store.appendJobRun({
        jobId: 'job_01305',
        jobRunId: 'jrun_01305',
        triggeredAt: '2026-04-27T23:00:00.000Z',
        triggeredBy: 'manual',
        status: 'claimed',
      })

      const inserted = store.jobStepRuns.insertMany('jrun_01305', 'onFailure', [
        { stepId: 'report', status: 'pending', attempt: 1 },
      ]).jobStepRuns
      expect(inserted).toEqual([
        expect.objectContaining({
          jobRunId: 'jrun_01305',
          phase: 'onFailure',
          stepId: 'report',
          status: 'pending',
          attempt: 1,
        }),
      ])

      store.jobStepRuns.insertMany('jrun_01305', 'sequence', [
        { stepId: 'work', status: 'pending', attempt: 1 },
        { stepId: 'closeout', status: 'pending', attempt: 1 },
      ])

      const updated = store.jobStepRuns.updateStep('jrun_01305', 'sequence', 'work', 1, {
        status: 'running',
        inputAttemptId: 'iat_01305',
        runId: 'run_01305',
        startedAt: '2026-04-27T23:01:00.000Z',
      }).jobStepRun
      expect(updated).toEqual(
        expect.objectContaining({
          status: 'running',
          inputAttemptId: 'iat_01305',
          runId: 'run_01305',
          startedAt: '2026-04-27T23:01:00.000Z',
        })
      )

      expect(store.jobStepRuns.getById('jrun_01305', 'sequence', 'work', 1).jobStepRun).toEqual(
        expect.objectContaining({ stepId: 'work', runId: 'run_01305' })
      )

      expect(
        store.jobStepRuns.listByJobRun('jrun_01305').jobStepRuns.map((step) => step.stepId)
      ).toEqual(['work', 'closeout', 'report'])
    } finally {
      store.close()
    }
  })
})
