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

describe('advanceJobFlow fresh event and manual steps', () => {
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
          triggeredBy: 'webhook',
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
        triggeredBy: 'webhook',
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
        triggeredBy: 'webhook',
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
})
