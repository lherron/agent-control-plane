import { describe, expect, test } from 'bun:test'
import type { JobFlowStep } from 'acp-core'
import {
  advanceCreatedFlow,
  agentStep,
  execStep,
  withFlowHarness,
} from '../fixtures/flow-engine.js'

// `next` is a step's success transition. A failed step fails its phase whether
// or not it names `next`; only exec/probe `branches` route on any result.
// T-13659: jobhunt's harvest agent step (next: classify) stalled on a
// permission prompt, its run failed turn_timeout, and the flow still ran
// classify and reported the job run succeeded.

function withNext(step: JobFlowStep, next: string): JobFlowStep {
  return { ...step, next } as JobFlowStep
}

function stepStatuses(
  jobsStore: Parameters<Parameters<typeof withFlowHarness>[0]>[0]['jobsStore'],
  jobRunId: string
) {
  return jobsStore.jobStepRuns
    .listByJobRun(jobRunId)
    .jobStepRuns.map((step) => [step.phase, step.stepId, step.status])
}

describe('advanceJobFlow explicit next', () => {
  test('a failed agent step with next does not run the next step and fails the job run', async () => {
    await withFlowHarness(
      async ({ deps, jobsStore, inputAttemptStore }) => {
        const { jobRun, advanced } = await advanceCreatedFlow({
          deps,
          jobsStore,
          flow: {
            sequence: [
              withNext(agentStep('harvest', 'harvest leads'), 'classify'),
              execStep('classify', 'process.stdout.write("classified")'),
            ],
            onFailure: [agentStep('alarm', 'harvest failed')],
          },
        })

        expect(advanced.status).toBe('failed')
        expect(advanced.errorCode).toBe('run_outcome_mismatch')
        expect(inputAttemptStore.calls.map((call) => call.content)).toEqual([
          'harvest leads',
          'harvest failed',
        ])
        expect(stepStatuses(jobsStore, jobRun.jobRunId)).toEqual([
          ['sequence', 'harvest', 'failed'],
          ['sequence', 'classify', 'skipped'],
          ['onFailure', 'alarm', 'succeeded'],
        ])
      },
      [{ status: 'failed' }]
    )
  })

  test('a failed agent step with next: succeed fails the job run', async () => {
    await withFlowHarness(
      async ({ deps, jobsStore }) => {
        const { advanced } = await advanceCreatedFlow({
          deps,
          jobsStore,
          flow: { sequence: [withNext(agentStep('brief', 'morning brief'), 'succeed')] },
        })

        expect(advanced.status).toBe('failed')
      },
      [{ status: 'failed' }]
    )
  })

  test('a succeeded agent step with next jumps to the named step', async () => {
    await withFlowHarness(async ({ deps, jobsStore, inputAttemptStore }) => {
      const { jobRun, advanced } = await advanceCreatedFlow({
        deps,
        jobsStore,
        flow: {
          sequence: [
            withNext(agentStep('harvest', 'harvest leads'), 'classify'),
            agentStep('skipped_over', 'must not run'),
            execStep('classify', 'process.stdout.write("classified")'),
          ],
        },
      })

      expect(advanced.status).toBe('succeeded')
      expect(inputAttemptStore.calls.map((call) => call.content)).toEqual(['harvest leads'])
      expect(stepStatuses(jobsStore, jobRun.jobRunId)).toEqual([
        ['sequence', 'harvest', 'succeeded'],
        ['sequence', 'skipped_over', 'pending'],
        ['sequence', 'classify', 'succeeded'],
      ])
    })
  })

  test('an exec step that exits non-zero with next and no branches fails the job run', async () => {
    await withFlowHarness(async ({ deps, jobsStore, inputAttemptStore }) => {
      const { jobRun, advanced } = await advanceCreatedFlow({
        deps,
        jobsStore,
        flow: {
          sequence: [
            execStep('collect', 'process.exit(1)', { next: 'report' }),
            agentStep('report', 'must not run after collect fails'),
          ],
        },
      })

      expect(advanced.status).toBe('failed')
      expect(inputAttemptStore.calls).toHaveLength(0)
      expect(stepStatuses(jobsStore, jobRun.jobRunId)).toEqual([
        ['sequence', 'collect', 'failed'],
        ['sequence', 'report', 'skipped'],
      ])
    })
  })

  test('a failed step with next: fail still fails the job run', async () => {
    await withFlowHarness(
      async ({ deps, jobsStore }) => {
        const { advanced } = await advanceCreatedFlow({
          deps,
          jobsStore,
          flow: { sequence: [withNext(agentStep('notify_infra', 'notify'), 'fail')] },
        })

        expect(advanced.status).toBe('failed')
      },
      [{ status: 'failed' }]
    )
  })
})
