import { describe, expect, test } from 'bun:test'
import type { JobRunStatus } from 'acp-jobs-store'
import { advanceJobFlow } from '../../src/jobs/flow-engine.js'
import {
  type JobsStore,
  createFlowJob,
  createJobRun,
  withFlowHarness,
} from '../fixtures/flow-engine.js'
import {
  advanceScheduledFreshRunWithPriorRuntime,
  hrcClientForFreshStep,
  scheduledFreshRunMetadata,
  seedPriorStepRun,
} from '../fixtures/flow-fresh-history.js'

function expectFreshCleanupDegraded(input: {
  advanced: { status: JobRunStatus; errorCode?: string | undefined }
  stepRun: NonNullable<ReturnType<JobsStore['jobStepRuns']['getById']>['jobStepRun']>
  order: string[]
  runtimeId: string
  expectedFailureCode: string
}) {
  // T-05415: cleanup failures are health degradations, not scheduled-run failures.
  expect(input.advanced).toMatchObject({ status: 'succeeded' })
  expect(input.advanced).not.toMatchObject({ errorCode: 'pre_run_cleanup_failed' })
  expect(input.order).toEqual([
    `terminate:${input.runtimeId}`,
    'resolveSession',
    'clearContext',
    'dispatch',
  ])
  expect(input.stepRun).toMatchObject({
    status: 'succeeded',
    error: undefined,
    degradation: {
      code: 'scheduled_fresh_pre_run_cleanup_degraded',
      previousRuntimeId: input.runtimeId,
      failureCode: input.expectedFailureCode,
    },
  })
}
describe('advanceJobFlow scheduled fresh pre-run cleanup', () => {
  test('T-05415: repeated terminate timeouts degrade and still rotate the scheduled fresh run', async () => {
    await withFlowHarness(
      async ({ deps, jobsStore, order }) => {
        const job = createFlowJob(jobsStore, {
          sequence: [{ id: 'fresh-start', input: 'start with fresh context', fresh: true }],
        })
        seedPriorStepRun({
          deps,
          jobsStore,
          job,
          jobRunId: 'jrun_prior_timeout_runtime',
          stepId: 'fresh-start',
          triggeredAt: '2026-04-28T12:00:00.000Z',
          runtimeId: 'rt-poison-timeout',
        })

        let lastAdvanced: { status: JobRunStatus; errorCode?: string | undefined } | undefined
        let lastStepRun:
          | NonNullable<ReturnType<JobsStore['jobStepRuns']['getById']>['jobStepRun']>
          | undefined
        for (const attempt of [1, 2, 3]) {
          order.length = 0
          const jobRun = createJobRun(jobsStore, job.jobId, {
            jobRunId: `jrun_current_timeout_${attempt}`,
            triggeredAt: `2026-04-28T12:${20 + attempt}:00.000Z`,
            triggeredBy: 'schedule',
            status: 'claimed',
          })

          lastAdvanced = await advanceJobFlow({
            deps: {
              ...deps,
              hrcClient: hrcClientForFreshStep({
                order,
                terminate: () => {
                  throw Object.assign(new Error('terminate timed out after 50ms'), {
                    code: 'terminate_timeout',
                  })
                },
              }),
            } as never,
            job,
            jobRun,
            actor: { kind: 'system', id: 'flow-engine-test' },
            now: `2026-04-28T12:${21 + attempt}:00.000Z`,
          })
          lastStepRun = jobsStore.jobStepRuns.getById(
            jobRun.jobRunId,
            'sequence',
            'fresh-start',
            1
          ).jobStepRun
        }

        expectFreshCleanupDegraded({
          advanced: lastAdvanced ?? { status: 'failed' },
          stepRun:
            lastStepRun ??
            (() => {
              throw new Error('expected final step run')
            })(),
          order,
          runtimeId: 'rt-poison-timeout',
          expectedFailureCode: 'terminate_timeout',
        })
      },
      [{ status: 'completed' }]
    )
  })

  test('T-05415: terminate 500 emits a health event and does not finalize the run with pre_run_cleanup_failed', async () => {
    await withFlowHarness(
      async ({ deps, jobsStore, order }) => {
        const { advanced, stepRun, priorRuntimeId } =
          await advanceScheduledFreshRunWithPriorRuntime({
            deps,
            jobsStore,
            order,
            priorRuntimeId: 'rt-poison-500',
            currentJobRunId: 'jrun_current_cleanup_500',
            terminate: () => {
              throw Object.assign(new Error('HRC terminate returned 500'), {
                code: 'http_500',
                status: 500,
              })
            },
          })

        expectFreshCleanupDegraded({
          advanced,
          stepRun,
          order,
          runtimeId: priorRuntimeId,
          expectedFailureCode: 'http_500',
        })
        expect(advanced).not.toMatchObject({
          status: 'failed',
          errorCode: 'pre_run_cleanup_failed',
        })
        const healthEvents = jobsStore.claimPendingInboxEvents({
          leaseOwner: 'flow-engine-test',
          leaseExpiresAt: '2026-04-28T12:22:00.000Z',
          now: '2026-04-28T12:21:30.000Z',
          limit: 10,
        })
        expect(healthEvents).toHaveLength(1)
        expect(healthEvents[0]).toMatchObject({
          source: 'acp-health',
          event: 'scheduled_fresh_pre_run_cleanup_degraded',
          payload: {
            event: 'scheduled_fresh_pre_run_cleanup_degraded',
            payload: {
              jobRunId: 'jrun_current_cleanup_500',
              stepId: 'fresh-start',
              previousRuntimeId: priorRuntimeId,
              failureCode: 'http_500',
            },
          },
        })
      },
      [{ status: 'completed' }]
    )
  })

  test.each([
    { code: 'unknown_runtime', message: 'unknown runtime "rt-already-gone"' },
    { code: 'runtime_unavailable', message: 'runtime "rt-already-gone" is terminated' },
  ])(
    'T-05415: terminate failing with benign $code is a clean success without degradation',
    async ({ code, message }) => {
      await withFlowHarness(
        async ({ deps, jobsStore, order }) => {
          const { advanced, stepRun, priorRuntimeId } =
            await advanceScheduledFreshRunWithPriorRuntime({
              deps,
              jobsStore,
              order,
              priorRuntimeId: 'rt-already-gone',
              currentJobRunId: 'jrun_current_already_gone',
              terminate: () => {
                throw Object.assign(new Error(message), { code })
              },
            })

          expect(advanced.status).toBe('succeeded')
          expect(order).toEqual([
            `terminate:${priorRuntimeId}`,
            'resolveSession',
            'clearContext',
            'dispatch',
          ])
          expect(stepRun.status).toBe('succeeded')
          expect(stepRun.error).toBeUndefined()
          expect(stepRun).not.toMatchObject({
            degradation: expect.objectContaining({
              code: 'scheduled_fresh_pre_run_cleanup_degraded',
            }),
          })
          expect(
            jobsStore.claimPendingInboxEvents({
              leaseOwner: 'flow-engine-test',
              leaseExpiresAt: '2026-04-28T12:22:00.000Z',
              now: '2026-04-28T12:21:30.000Z',
              limit: 10,
            })
          ).toHaveLength(0)
        },
        [{ status: 'completed' }]
      )
    }
  )

  test('T-05415: reaped still-running predecessor is treated as terminal so the next scheduled fresh run proceeds', async () => {
    await withFlowHarness(
      async ({ deps, jobsStore, order }) => {
        const job = createFlowJob(jobsStore, {
          sequence: [
            {
              id: 'fresh-start',
              input: 'must not wedge after predecessor reaper terminalizes the run',
              fresh: true,
              freshDuration: 'PT24H',
            },
          ],
        })
        seedPriorStepRun({
          deps,
          jobsStore,
          job,
          jobRunId: 'jrun_prior_reaped_running',
          stepId: 'fresh-start',
          triggeredAt: '2026-04-28T12:00:00.000Z',
          stepStatus: 'running',
          jobRunStatus: 'failed',
          runStatus: 'running',
          runtimeId: 'rt-prior-reaped-running',
          runMetadata: scheduledFreshRunMetadata({
            job,
            windowStartedAt: '2026-04-28T12:00:00.000Z',
          }),
        })
        const jobRun = createJobRun(jobsStore, job.jobId, {
          jobRunId: 'jrun_current_after_reaper',
          triggeredAt: '2026-04-29T12:20:00.000Z',
          triggeredBy: 'schedule',
          status: 'claimed',
        })

        const advanced = await advanceJobFlow({
          deps: {
            ...deps,
            hrcClient: hrcClientForFreshStep({ order }),
          } as never,
          job,
          jobRun,
          actor: { kind: 'system', id: 'flow-engine-test' },
          now: '2026-04-29T12:21:00.000Z',
        })

        expect(advanced.status).toBe('succeeded')
        expect(advanced).not.toMatchObject({ errorCode: 'pre_run_cleanup_failed' })
        expect(order).toEqual([
          'terminate:rt-prior-reaped-running',
          'resolveSession',
          'clearContext',
          'dispatch',
        ])
        expect(
          jobsStore.jobStepRuns.getById(jobRun.jobRunId, 'sequence', 'fresh-start', 1).jobStepRun
        ).toMatchObject({ status: 'succeeded', error: undefined })
      },
      [{ status: 'completed' }]
    )
  })

  test('unknown termination errors fail closed and do not dispatch', async () => {
    await withFlowHarness(async ({ deps, jobsStore, inputAttemptStore, launchCalls, order }) => {
      const job = createFlowJob(jobsStore, {
        sequence: [{ id: 'fresh-start', input: 'start with fresh context', fresh: true }],
      })
      seedPriorStepRun({
        deps,
        jobsStore,
        job,
        jobRunId: 'jrun_prior',
        stepId: 'fresh-start',
        triggeredAt: '2026-04-28T12:00:00.000Z',
        runtimeId: 'rt-prior',
      })
      const jobRun = createJobRun(jobsStore, job.jobId, {
        jobRunId: 'jrun_current',
        triggeredAt: '2026-04-28T12:20:00.000Z',
        triggeredBy: 'schedule',
        status: 'claimed',
      })

      const advanced = await advanceJobFlow({
        deps: {
          ...deps,
          hrcClient: hrcClientForFreshStep({
            order,
            failIfRotated: true,
            terminate: () => {
              throw Object.assign(new Error('socket hung up'), {
                code: 'transport_unavailable',
              })
            },
          }),
        } as never,
        job,
        jobRun,
        actor: { kind: 'system', id: 'flow-engine-test' },
        now: '2026-04-28T12:21:00.000Z',
      })

      expect(advanced.status).toBe('failed')
      expect(inputAttemptStore.calls).toHaveLength(0)
      expect(launchCalls).toHaveLength(0)
      expect(order).toEqual(['terminate:rt-prior'])
      expect(
        jobsStore.jobStepRuns.getById(jobRun.jobRunId, 'sequence', 'fresh-start', 1).jobStepRun
      ).toMatchObject({
        status: 'failed',
        error: {
          code: 'pre_run_cleanup_failed',
          message: 'failed to clean previous fresh step runtime rt-prior: socket hung up',
        },
      })
    })
  })
})
describe('preserved flow branch and incident', () => {
  test('T-05415: already gone runtime remains a clean success without degradation', async () => {
    await withFlowHarness(
      async ({ deps, jobsStore, order }) => {
        const { advanced, stepRun, priorRuntimeId } =
          await advanceScheduledFreshRunWithPriorRuntime({
            deps,
            jobsStore,
            order,
            priorRuntimeId: 'rt-already-gone',
            currentJobRunId: 'jrun_current_already_gone',
            terminate: () => {
              throw Object.assign(new Error('unknown runtime "rt-already-gone"'), {
                code: 'unknown_runtime',
              })
            },
          })

        expect(advanced.status).toBe('succeeded')
        expect(order).toEqual([
          `terminate:${priorRuntimeId}`,
          'resolveSession',
          'clearContext',
          'dispatch',
        ])
        expect(stepRun.status).toBe('succeeded')
        expect(stepRun.error).toBeUndefined()
        expect(stepRun).not.toMatchObject({
          degradation: expect.objectContaining({
            code: 'scheduled_fresh_pre_run_cleanup_degraded',
          }),
        })
        expect(
          jobsStore.claimPendingInboxEvents({
            leaseOwner: 'flow-engine-test',
            leaseExpiresAt: '2026-04-28T12:22:00.000Z',
            now: '2026-04-28T12:21:30.000Z',
            limit: 10,
          })
        ).toHaveLength(0)
      },
      [{ status: 'completed' }]
    )
  })
})
