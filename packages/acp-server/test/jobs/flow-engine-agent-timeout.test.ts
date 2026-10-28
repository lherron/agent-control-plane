import { describe, expect, test } from 'bun:test'
import { advanceJobFlow } from '../../src/jobs/flow-engine.js'
import { createFlowJob, createJobRun, withFlowHarness } from '../fixtures/flow-engine.js'

describe('advanceJobFlow scheduled fresh pre-run cleanup', () => {
  test('hung agent step timeout fails the step and returns without waiting for HRC termination', async () => {
    await withFlowHarness(async ({ deps, jobsStore }) => {
      const job = createFlowJob(jobsStore, {
        sequence: [{ id: 'hung-agent', input: 'never respond', timeout: 'PT1M' }],
      })
      const currentRun = deps.runStore.createRun({
        sessionRef: { scopeRef: job.scopeRef, laneRef: job.laneRef },
        status: 'running',
      })
      deps.runStore.updateRun(currentRun.runId, {
        status: 'running',
        runtimeId: 'rt-hung-agent',
        hrcRunId: `hrc-${currentRun.runId}`,
      })
      const jobRun = createJobRun(jobsStore, job.jobId, {
        jobRunId: 'jrun_hung_agent_timeout',
        triggeredAt: '2026-04-28T12:00:00.000Z',
        triggeredBy: 'schedule',
        status: 'dispatched',
      })
      jobsStore.jobStepRuns.insertMany(jobRun.jobRunId, 'sequence', [
        {
          stepId: 'hung-agent',
          status: 'running',
          attempt: 1,
          runId: currentRun.runId,
          startedAt: '2026-04-28T12:00:00.000Z',
        },
      ])

      const terminateCalls: Array<{ runtimeId: string; options: unknown }> = []
      const advanced = await Promise.race([
        advanceJobFlow({
          deps: {
            ...deps,
            hrcClient: {
              terminate: (runtimeId: string, options: unknown) => {
                terminateCalls.push({ runtimeId, options })
                return new Promise(() => {
                  // Intentionally unresolved: the reaper/timeout path must write
                  // terminal store state before bounded best-effort termination.
                })
              },
            },
          } as never,
          job,
          jobRun,
          actor: { kind: 'system', id: 'flow-engine-test' },
          now: '2026-04-28T12:02:00.000Z',
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('advanceJobFlow waited on HRC termination')), 150)
        ),
      ])

      expect(terminateCalls).toHaveLength(1)
      expect(terminateCalls[0]?.runtimeId).toBe('rt-hung-agent')
      expect(advanced).toMatchObject({
        status: 'failed',
        errorCode: 'agent_step_timeout',
        completedAt: '2026-04-28T12:02:00.000Z',
      })
      expect(
        jobsStore.jobStepRuns.getById(jobRun.jobRunId, 'sequence', 'hung-agent', 1).jobStepRun
      ).toMatchObject({
        status: 'failed',
        error: { code: 'agent_step_timeout' },
        completedAt: '2026-04-28T12:02:00.000Z',
      })
    })
  })
})
