import { describe, expect, test } from 'bun:test'
import { advanceJobFlow } from '../../src/jobs/flow-engine.js'
import { createFlowJob, createJobRun, withFlowHarness } from '../fixtures/flow-engine.js'
import {
  hrcClientForFreshStep,
  scheduledFreshRunMetadata,
  seedPriorStepRun,
} from '../fixtures/flow-fresh-history.js'

describe('advanceJobFlow scheduled freshDuration windows', () => {
  test('first scheduled run rotates context and records window metadata', async () => {
    await withFlowHarness(
      async ({ deps, jobsStore, order }) => {
        const job = createFlowJob(jobsStore, {
          sequence: [
            {
              id: 'fresh-start',
              input: 'start with fresh context',
              fresh: true,
              freshDuration: 'PT24H',
            },
          ],
        })
        const jobRun = createJobRun(jobsStore, job.jobId, {
          jobRunId: 'jrun_first_duration',
          triggeredAt: '2026-04-28T12:00:00.000Z',
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
          now: '2026-04-28T12:01:00.000Z',
        })

        expect(advanced.status).toBe('succeeded')
        expect(order).toEqual(['resolveSession', 'clearContext', 'dispatch'])
        const stepRun = jobsStore.jobStepRuns.getById(
          jobRun.jobRunId,
          'sequence',
          'fresh-start',
          1
        ).jobStepRun
        const run = deps.runStore.getRun(stepRun?.runId ?? '')
        expect(run?.metadata?.['scheduledFresh']).toEqual({
          jobId: job.jobId,
          phase: 'sequence',
          stepId: 'fresh-start',
          freshDuration: 'PT24H',
          windowStartedAt: '2026-04-28T12:01:00.000Z',
        })
      },
      [{ status: 'completed' }]
    )
  })

  test('inside freshDuration dispatches without terminate or clear and propagates the window', async () => {
    await withFlowHarness(
      async ({ deps, jobsStore, order }) => {
        const job = createFlowJob(jobsStore, {
          sequence: [
            {
              id: 'fresh-start',
              input: 'continue inside retained session',
              fresh: true,
              freshDuration: 'PT24H',
            },
          ],
        })
        seedPriorStepRun({
          deps,
          jobsStore,
          job,
          jobRunId: 'jrun_prior_duration',
          stepId: 'fresh-start',
          triggeredAt: '2026-04-28T12:00:00.000Z',
          runtimeId: 'rt-prior-duration',
          runMetadata: scheduledFreshRunMetadata({
            job,
            windowStartedAt: '2026-04-28T12:00:00.000Z',
          }),
        })
        const jobRun = createJobRun(jobsStore, job.jobId, {
          jobRunId: 'jrun_inside_duration',
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
                throw new Error('inside-window run must not pre-clean')
              },
            }),
          } as never,
          job,
          jobRun,
          actor: { kind: 'system', id: 'flow-engine-test' },
          now: '2026-04-28T12:21:00.000Z',
        })

        expect(advanced.status).toBe('succeeded')
        expect(order).toEqual(['dispatch'])
        const stepRun = jobsStore.jobStepRuns.getById(
          jobRun.jobRunId,
          'sequence',
          'fresh-start',
          1
        ).jobStepRun
        const run = deps.runStore.getRun(stepRun?.runId ?? '')
        expect(run?.metadata?.['scheduledFresh']).toEqual({
          jobId: job.jobId,
          phase: 'sequence',
          stepId: 'fresh-start',
          freshDuration: 'PT24H',
          windowStartedAt: '2026-04-28T12:00:00.000Z',
        })
      },
      [{ status: 'completed' }]
    )
  })

  test('at the freshDuration boundary terminates the prior runtime and starts a new window', async () => {
    await withFlowHarness(
      async ({ deps, jobsStore, order }) => {
        const job = createFlowJob(jobsStore, {
          sequence: [
            {
              id: 'fresh-start',
              input: 'rotate at duration boundary',
              fresh: true,
              freshDuration: 'PT24H',
            },
          ],
        })
        seedPriorStepRun({
          deps,
          jobsStore,
          job,
          jobRunId: 'jrun_prior_boundary',
          stepId: 'fresh-start',
          triggeredAt: '2026-04-28T12:00:00.000Z',
          runtimeId: 'rt-prior-boundary',
          runMetadata: scheduledFreshRunMetadata({
            job,
            windowStartedAt: '2026-04-28T12:00:00.000Z',
          }),
        })
        const terminateCalls: Array<{ runtimeId: string; options: unknown }> = []
        const jobRun = createJobRun(jobsStore, job.jobId, {
          jobRunId: 'jrun_boundary',
          triggeredAt: '2026-04-29T12:00:00.000Z',
          triggeredBy: 'catch-up',
          status: 'claimed',
        })

        const advanced = await advanceJobFlow({
          deps: {
            ...deps,
            hrcClient: hrcClientForFreshStep({ order, terminateCalls }),
          } as never,
          job,
          jobRun,
          actor: { kind: 'system', id: 'flow-engine-test' },
          now: '2026-04-29T12:00:00.000Z',
        })

        expect(advanced.status).toBe('succeeded')
        expect(order).toEqual([
          'terminate:rt-prior-boundary',
          'resolveSession',
          'clearContext',
          'dispatch',
        ])
        expect(terminateCalls.map((call) => call.runtimeId)).toEqual(['rt-prior-boundary'])
        const stepRun = jobsStore.jobStepRuns.getById(
          jobRun.jobRunId,
          'sequence',
          'fresh-start',
          1
        ).jobStepRun
        const run = deps.runStore.getRun(stepRun?.runId ?? '')
        expect(run?.metadata?.['scheduledFresh']).toMatchObject({
          freshDuration: 'PT24H',
          windowStartedAt: '2026-04-29T12:00:00.000Z',
        })
      },
      [{ status: 'completed' }]
    )
  })

  test('missing metadata and changed duration rotate once and seed explicit metadata', async () => {
    for (const prior of [
      { name: 'missing-metadata', metadata: undefined },
      { name: 'duration-mismatch', metadata: 'mismatch' },
    ] as const) {
      await withFlowHarness(
        async ({ deps, jobsStore, order }) => {
          const job = createFlowJob(jobsStore, {
            sequence: [
              {
                id: 'fresh-start',
                input: `rotate for ${prior.name}`,
                fresh: true,
                freshDuration: 'PT24H',
              },
            ],
          })
          seedPriorStepRun({
            deps,
            jobsStore,
            job,
            jobRunId: `jrun_prior_${prior.name}`,
            stepId: 'fresh-start',
            triggeredAt: '2026-04-28T12:00:00.000Z',
            runtimeId: `rt-prior-${prior.name}`,
            ...(prior.metadata === 'mismatch'
              ? {
                  runMetadata: scheduledFreshRunMetadata({
                    job,
                    freshDuration: 'PT1H',
                    windowStartedAt: '2026-04-28T12:00:00.000Z',
                  }),
                }
              : {}),
          })
          const jobRun = createJobRun(jobsStore, job.jobId, {
            jobRunId: `jrun_current_${prior.name}`,
            triggeredAt: '2026-04-28T12:20:00.000Z',
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
            now: '2026-04-28T12:21:00.000Z',
          })

          expect(advanced.status).toBe('succeeded')
          expect(order).toEqual([
            `terminate:rt-prior-${prior.name}`,
            'resolveSession',
            'clearContext',
            'dispatch',
          ])
          const stepRun = jobsStore.jobStepRuns.getById(
            jobRun.jobRunId,
            'sequence',
            'fresh-start',
            1
          ).jobStepRun
          const run = deps.runStore.getRun(stepRun?.runId ?? '')
          expect(run?.metadata?.['scheduledFresh']).toMatchObject({
            freshDuration: 'PT24H',
            windowStartedAt: '2026-04-28T12:21:00.000Z',
          })
        },
        [{ status: 'completed' }]
      )
    }
  })

  test('newest prior same-identity step still running fails closed without dispatch', async () => {
    await withFlowHarness(async ({ deps, jobsStore, inputAttemptStore, launchCalls, order }) => {
      const job = createFlowJob(jobsStore, {
        sequence: [
          {
            id: 'fresh-start',
            input: 'must not overlap retained runtime',
            fresh: true,
            freshDuration: 'PT24H',
          },
        ],
      })
      seedPriorStepRun({
        deps,
        jobsStore,
        job,
        jobRunId: 'jrun_prior_running',
        stepId: 'fresh-start',
        triggeredAt: '2026-04-28T12:00:00.000Z',
        stepStatus: 'running',
        jobRunStatus: 'running',
        runStatus: 'running',
        runtimeId: 'rt-prior-running',
        runMetadata: scheduledFreshRunMetadata({
          job,
          windowStartedAt: '2026-04-28T12:00:00.000Z',
        }),
      })
      const jobRun = createJobRun(jobsStore, job.jobId, {
        jobRunId: 'jrun_current_running',
        triggeredAt: '2026-04-28T12:20:00.000Z',
        triggeredBy: 'schedule',
        status: 'claimed',
      })

      const advanced = await advanceJobFlow({
        deps: {
          ...deps,
          hrcClient: hrcClientForFreshStep({ order, failIfRotated: true }),
        } as never,
        job,
        jobRun,
        actor: { kind: 'system', id: 'flow-engine-test' },
        now: '2026-04-28T12:21:00.000Z',
      })

      expect(advanced.status).toBe('failed')
      expect(inputAttemptStore.calls).toHaveLength(0)
      expect(launchCalls).toHaveLength(0)
      expect(order).toEqual([])
      expect(
        jobsStore.jobStepRuns.getById(jobRun.jobRunId, 'sequence', 'fresh-start', 1).jobStepRun
      ).toMatchObject({
        status: 'failed',
        error: {
          code: 'pre_run_cleanup_failed',
          message: 'previous fresh step jrun_prior_running/sequence/fresh-start is still running',
        },
      })
    })
  })

  test('manual and webhook freshDuration runs preserve ordinary fresh rotation without pre-clean', async () => {
    for (const triggeredBy of ['manual', 'webhook'] as const) {
      await withFlowHarness(
        async ({ deps, jobsStore, order }) => {
          const job = createFlowJob(jobsStore, {
            sequence: [
              {
                id: 'fresh-start',
                input: 'manual debug run',
                fresh: true,
                freshDuration: 'PT24H',
              },
            ],
          })
          seedPriorStepRun({
            deps,
            jobsStore,
            job,
            jobRunId: `jrun_prior_${triggeredBy}_duration`,
            stepId: 'fresh-start',
            triggeredAt: '2026-04-28T12:00:00.000Z',
            runtimeId: `rt-prior-${triggeredBy}-duration`,
            runMetadata: scheduledFreshRunMetadata({
              job,
              windowStartedAt: '2026-04-28T12:00:00.000Z',
            }),
          })
          const jobRun = createJobRun(jobsStore, job.jobId, {
            jobRunId: `jrun_current_${triggeredBy}_duration`,
            triggeredAt: '2026-04-28T12:20:00.000Z',
            triggeredBy,
            status: 'claimed',
          })

          const advanced = await advanceJobFlow({
            deps: {
              ...deps,
              hrcClient: hrcClientForFreshStep({
                order,
                terminate: () => {
                  throw new Error('manual/webhook duration runs must not pre-clean')
                },
              }),
            } as never,
            job,
            jobRun,
            actor: { kind: 'system', id: 'flow-engine-test' },
            now: '2026-04-28T12:21:00.000Z',
          })

          expect(advanced.status).toBe('succeeded')
          expect(order).toEqual(['resolveSession', 'clearContext', 'dispatch'])
        },
        [{ status: 'completed' }]
      )
    }
  })
})
