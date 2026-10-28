import { describe, expect, test } from 'bun:test'
import { advanceJobFlow } from '../../src/jobs/flow-engine.js'
import {
  agentStep,
  createFlowJob,
  createJobRun,
  execStep,
  withFlowHarness,
} from '../fixtures/flow-engine.js'
import { hrcClientForFreshStep, seedPriorStepRun } from '../fixtures/flow-fresh-history.js'

describe('advanceJobFlow scheduled fresh pre-run cleanup', () => {
  test('terminates the previous stored runtime before schedule and catch-up fresh dispatches', async () => {
    for (const triggeredBy of ['schedule', 'catch-up'] as const) {
      await withFlowHarness(
        async ({ deps, jobsStore, order }) => {
          const job = createFlowJob(jobsStore, {
            sequence: [{ id: 'fresh-start', input: 'start with fresh context', fresh: true }],
          })
          seedPriorStepRun({
            deps,
            jobsStore,
            job,
            jobRunId: `jrun_prior_${triggeredBy}`,
            stepId: 'fresh-start',
            triggeredAt: '2026-04-28T12:00:00.000Z',
            runtimeId: `rt-prior-${triggeredBy}`,
          })
          const terminateCalls: Array<{ runtimeId: string; options: unknown }> = []
          const jobRun = createJobRun(jobsStore, job.jobId, {
            jobRunId: `jrun_current_${triggeredBy}`,
            triggeredAt: '2026-04-28T12:20:00.000Z',
            triggeredBy,
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
            now: '2026-04-28T12:21:00.000Z',
          })

          expect(advanced.status).toBe('succeeded')
          expect(order).toEqual([
            `terminate:rt-prior-${triggeredBy}`,
            'resolveSession',
            'clearContext',
            'dispatch',
          ])
          expect(terminateCalls).toEqual([
            {
              runtimeId: `rt-prior-${triggeredBy}`,
              options: {
                dropContinuation: false,
                reason: 'scheduled_fresh_pre_run_cleanup',
                source: 'acp-scheduled-job-runner',
                actor: 'system:flow-engine-test',
              },
            },
          ])
        },
        [{ status: 'completed' }]
      )
    }
  })

  test('manual and webhook runs keep their prior runtime for debugging', async () => {
    for (const triggeredBy of ['manual', 'webhook'] as const) {
      await withFlowHarness(
        async ({ deps, jobsStore, order }) => {
          const job = createFlowJob(jobsStore, {
            sequence: [{ id: 'fresh-start', input: 'start with fresh context', fresh: true }],
          })
          seedPriorStepRun({
            deps,
            jobsStore,
            job,
            jobRunId: `jrun_prior_${triggeredBy}`,
            stepId: 'fresh-start',
            triggeredAt: '2026-04-28T12:00:00.000Z',
            runtimeId: `rt-prior-${triggeredBy}`,
          })
          const terminateCalls: Array<{ runtimeId: string; options: unknown }> = []
          const jobRun = createJobRun(jobsStore, job.jobId, {
            jobRunId: `jrun_current_${triggeredBy}`,
            triggeredAt: '2026-04-28T12:20:00.000Z',
            triggeredBy,
            status: 'claimed',
          })

          const advanced = await advanceJobFlow({
            deps: {
              ...deps,
              hrcClient: hrcClientForFreshStep({
                order,
                terminateCalls,
                terminate: () => {
                  throw new Error('manual/webhook runs must not pre-clean')
                },
              }),
            } as never,
            job,
            jobRun,
            actor: { kind: 'system', id: 'flow-engine-test' },
            now: '2026-04-28T12:21:00.000Z',
          })

          expect(advanced.status).toBe('succeeded')
          expect(terminateCalls).toHaveLength(0)
          expect(order).toEqual(['resolveSession', 'clearContext', 'dispatch'])
        },
        [{ status: 'completed' }]
      )
    }
  })

  test('non-fresh, exec, and native steps do not pre-clean', async () => {
    await withFlowHarness(
      async ({ deps, jobsStore, order }) => {
        const job = createFlowJob(jobsStore, {
          sequence: [agentStep('regular', 'run without fresh context')],
        })
        seedPriorStepRun({
          deps,
          jobsStore,
          job,
          jobRunId: 'jrun_prior_regular',
          stepId: 'regular',
          triggeredAt: '2026-04-28T12:00:00.000Z',
          runtimeId: 'rt-prior-regular',
        })
        const jobRun = createJobRun(jobsStore, job.jobId, {
          jobRunId: 'jrun_current_regular',
          triggeredAt: '2026-04-28T12:20:00.000Z',
          triggeredBy: 'schedule',
          status: 'claimed',
        })

        const advanced = await advanceJobFlow({
          deps: {
            ...deps,
            hrcClient: hrcClientForFreshStep({
              order,
              terminate: () => {
                throw new Error('non-fresh steps must not pre-clean')
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
      },
      [{ status: 'completed' }]
    )

    await withFlowHarness(async ({ deps, jobsStore, order }) => {
      const job = createFlowJob(jobsStore, {
        sequence: [execStep('probe', 'process.exit(0)', { fresh: true })],
      })
      const jobRun = createJobRun(jobsStore, job.jobId, {
        jobRunId: 'jrun_exec',
        triggeredAt: '2026-04-28T12:20:00.000Z',
        triggeredBy: 'schedule',
        status: 'claimed',
      })

      const advanced = await advanceJobFlow({
        deps: {
          ...deps,
          hrcClient: hrcClientForFreshStep({
            order,
            terminate: () => {
              throw new Error('exec steps must not pre-clean')
            },
          }),
        } as never,
        job,
        jobRun,
        actor: { kind: 'system', id: 'flow-engine-test' },
        now: '2026-04-28T12:21:00.000Z',
      })

      expect(advanced.status).toBe('succeeded')
      expect(order).toEqual([])
    })

    await withFlowHarness(async ({ deps, jobsStore, order }) => {
      deps.nativeStepExecutor = {
        wrkqTaskPort: {
          async createOrFind(input) {
            return {
              taskId: 'T-09123',
              projectId: 'agent-control-plane',
              taskPath: input.path,
              created: true,
            }
          },
        },
        sendPulpitMessage: async () => ({ deliveryRequestId: 'dr_native', bindingId: 'binding' }),
        dispatchAgentInput: async () => ({
          to: 'fettle@agent-control-plane:T-1',
          envelopeId: 'EN-00001',
        }),
      }
      const job = createFlowJob(jobsStore, {
        sequence: [
          {
            id: 'create_task',
            kind: 'wrkq-task',
            title: 'Incident',
            container: 'agent-control-plane/inbox',
            fresh: true,
          },
        ],
      })
      const jobRun = createJobRun(jobsStore, job.jobId, {
        jobRunId: 'jrun_native',
        triggeredAt: '2026-04-28T12:20:00.000Z',
        triggeredBy: 'schedule',
        status: 'claimed',
      })

      const advanced = await advanceJobFlow({
        deps: {
          ...deps,
          hrcClient: hrcClientForFreshStep({
            order,
            terminate: () => {
              throw new Error('native steps must not pre-clean')
            },
          }),
        } as never,
        job,
        jobRun,
        actor: { kind: 'system', id: 'flow-engine-test' },
        now: '2026-04-28T12:21:00.000Z',
      })

      expect(advanced.status).toBe('succeeded')
      expect(order).toEqual([])
    })
  })

  test('already-dispatched fresh steps are reconciled without pre-cleaning again', async () => {
    await withFlowHarness(async ({ deps, jobsStore, launchCalls, order }) => {
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
      const currentRun = deps.runStore.createRun({
        sessionRef: { scopeRef: job.scopeRef, laneRef: job.laneRef },
        status: 'completed',
      })
      deps.runStore.updateRun(currentRun.runId, {
        status: 'completed',
        runtimeId: 'rt-current',
        hrcRunId: `hrc-${currentRun.runId}`,
      })
      const jobRun = createJobRun(jobsStore, job.jobId, {
        jobRunId: 'jrun_current',
        triggeredAt: '2026-04-28T12:20:00.000Z',
        triggeredBy: 'schedule',
        status: 'claimed',
      })
      jobsStore.jobStepRuns.insertMany(jobRun.jobRunId, 'sequence', [
        {
          stepId: 'fresh-start',
          status: 'running',
          attempt: 1,
          runId: currentRun.runId,
          startedAt: '2026-04-28T12:20:00.000Z',
        },
      ])

      const advanced = await advanceJobFlow({
        deps: {
          ...deps,
          hrcClient: hrcClientForFreshStep({
            order,
            terminate: () => {
              throw new Error('already-dispatched steps must not pre-clean')
            },
          }),
        } as never,
        job,
        jobRun,
        actor: { kind: 'system', id: 'flow-engine-test' },
        now: '2026-04-28T12:21:00.000Z',
      })

      expect(advanced.status).toBe('succeeded')
      expect(order).toEqual([])
      expect(launchCalls).toHaveLength(0)
      expect(
        jobsStore.jobStepRuns.getById(jobRun.jobRunId, 'sequence', 'fresh-start', 1).jobStepRun
      ).toMatchObject({ status: 'succeeded', runId: currentRun.runId })
    })
  })

  test('target selection scans past no-runId placeholders and ignores other jobs', async () => {
    await withFlowHarness(
      async ({ deps, jobsStore, order }) => {
        const job = createFlowJob(jobsStore, {
          sequence: [{ id: 'fresh-start', input: 'start with fresh context', fresh: true }],
        })
        const otherJob = createFlowJob(jobsStore, {
          sequence: [{ id: 'fresh-start', input: 'other job', fresh: true }],
        })
        seedPriorStepRun({
          deps,
          jobsStore,
          job: otherJob,
          jobRunId: 'jrun_other',
          stepId: 'fresh-start',
          triggeredAt: '2026-04-28T12:25:00.000Z',
          runtimeId: 'rt-other-job',
        })
        seedPriorStepRun({
          deps,
          jobsStore,
          job,
          jobRunId: 'jrun_newer_placeholder',
          stepId: 'fresh-start',
          triggeredAt: '2026-04-28T12:15:00.000Z',
          createRunRecord: false,
          stepStatus: 'failed',
        })
        seedPriorStepRun({
          deps,
          jobsStore,
          job,
          jobRunId: 'jrun_older_runtime',
          stepId: 'fresh-start',
          triggeredAt: '2026-04-28T12:00:00.000Z',
          runtimeId: 'rt-older-runtime',
        })
        const terminateCalls: Array<{ runtimeId: string; options: unknown }> = []
        const jobRun = createJobRun(jobsStore, job.jobId, {
          jobRunId: 'jrun_current',
          triggeredAt: '2026-04-28T12:30:00.000Z',
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
          now: '2026-04-28T12:31:00.000Z',
        })

        expect(advanced.status).toBe('succeeded')
        expect(terminateCalls.map((call) => call.runtimeId)).toEqual(['rt-older-runtime'])
        expect(order[0]).toBe('terminate:rt-older-runtime')
      },
      [{ status: 'completed' }]
    )
  })

  test('missing ownership data fails closed without creating a new input attempt', async () => {
    await withFlowHarness(async ({ deps, jobsStore, inputAttemptStore, launchCalls, order }) => {
      const job = createFlowJob(jobsStore, {
        sequence: [{ id: 'fresh-start', input: 'start with fresh context', fresh: true }],
      })
      seedPriorStepRun({
        deps,
        jobsStore,
        job,
        jobRunId: 'jrun_prior_missing_run',
        stepId: 'fresh-start',
        triggeredAt: '2026-04-28T12:00:00.000Z',
        runId: 'run_missing',
        createRunRecord: false,
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
          message: 'previous fresh step run run_missing has no ACP run record',
        },
      })
    })
  })
})
