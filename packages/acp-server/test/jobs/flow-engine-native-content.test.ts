import { describe, expect, test } from 'bun:test'
import type { NativeStepExecutorDeps } from 'acp-jobs-store'
import { advanceJobFlow } from '../../src/jobs/flow-engine.js'
import {
  advanceCreatedFlow,
  createFlowJob,
  createJobRun,
  execResult,
  execStep,
  withFlowHarness,
} from '../fixtures/flow-engine.js'

function recordingPulpitContent(
  pulpitTexts: string[],
  deliveryRequestId: string
): Omit<NativeStepExecutorDeps, 'store'> {
  return {
    wrkqTaskPort: {
      async createOrFind() {
        throw new Error('wrkq should not run')
      },
    },
    sendPulpitMessage: async (input) => {
      pulpitTexts.push(input.text)
      return { deliveryRequestId, bindingId: 'binding' }
    },
    dispatchAgentInput: async () => {
      throw new Error('agent dispatch should not run')
    },
  }
}

describe('advanceJobFlow exec steps', () => {
  test('native side-effect steps execute through the flow engine and resolve prior step output', async () => {
    await withFlowHarness(async ({ deps, jobsStore }) => {
      const calls: {
        wrkq: Array<Parameters<NativeStepExecutorDeps['wrkqTaskPort']['createOrFind']>[0]>
        pulpit: Array<Parameters<NativeStepExecutorDeps['sendPulpitMessage']>[0]>
        dispatch: Array<Parameters<NativeStepExecutorDeps['dispatchAgentInput']>[0]>
      } = { wrkq: [], pulpit: [], dispatch: [] }
      deps.nativeStepExecutor = {
        wrkqTaskPort: {
          async createOrFind(input) {
            calls.wrkq.push(input)
            return {
              taskId: 'T-09123',
              projectId: 'agent-control-plane',
              taskPath: input.path,
              created: true,
            }
          },
        },
        sendPulpitMessage: async (input) => {
          calls.pulpit.push(input)
          return { deliveryRequestId: 'dr_native_001', bindingId: input.bindingId ?? 'binding' }
        },
        dispatchAgentInput: async (input) => {
          calls.dispatch.push(input)
          return { to: 'fettle@agent-control-plane:T-09123', envelopeId: 'EN-00001' }
        },
      }

      const { jobRun, advanced } = await advanceCreatedFlow({
        deps,
        jobsStore,
        flow: {
          sequence: [
            {
              id: 'create_task',
              kind: 'wrkq-task',
              title: 'Incident',
              container: 'agent-control-plane/inbox',
            },
            {
              id: 'notify',
              kind: 'pulpit-message',
              binding: 'agent-fettle.discord-primary',
              content: 'Dispatching fettle for {{create_task.taskId}}',
            },
            {
              id: 'dispatch',
              kind: 'agent-dispatch',
              agentId: 'fettle',
              projectId: 'agent-control-plane',
              scopeRef: { $step: 'create_task', field: 'taskId' },
              laneRef: 'main',
              input: { content: 'Investigate {{create_task.taskId}}' },
            },
          ],
        },
      })

      expect(advanced.status).toBe('succeeded')
      expect(calls.wrkq).toHaveLength(1)
      expect(calls.pulpit[0]?.text).toBe('Dispatching fettle for T-09123')
      expect(calls.dispatch[0]).toMatchObject({
        scopeRef: 'agent:fettle:project:agent-control-plane:task:T-09123',
        laneRef: 'main',
        content: 'Investigate T-09123',
      })
      expect(
        jobsStore.jobStepRuns
          .listByJobRun(jobRun.jobRunId)
          .jobStepRuns.map((step) => [step.stepId, step.status])
      ).toEqual([
        ['create_task', 'succeeded'],
        ['notify', 'succeeded'],
        ['dispatch', 'succeeded'],
      ])
    })
  })

  test('selected failed exec branch exposes persisted result diagnostics to native content', async () => {
    await withFlowHarness(async ({ deps, jobsStore }) => {
      const pulpitTexts: string[] = []
      deps.nativeStepExecutor = recordingPulpitContent(pulpitTexts, 'dr_failed_result')

      const { advanced } = await advanceCreatedFlow({
        deps,
        jobsStore,
        flow: {
          sequence: [
            execStep('poll', 'console.error("xAI upstream HTTP 503"); process.exit(2)', {
              branches: { default: 'notify' },
            }),
            {
              id: 'notify',
              kind: 'pulpit-message',
              binding: 'agent-mneme.discord-primary',
              content: 'error={{poll.errorMessage}} stderr={{poll.stderr}} stdout={{poll.stdout}}',
            },
          ],
        },
      })

      expect(advanced.status).toBe('succeeded')
      expect(pulpitTexts).toEqual(['error= stderr=xAI upstream HTTP 503\n stdout='])
    })
  })

  test('selected failed exec branch exposes persisted runner errors to native content', async () => {
    await withFlowHarness(async ({ deps, jobsStore }) => {
      const pulpitTexts: string[] = []
      deps.jobExecPolicy = { ...deps.jobExecPolicy, enabled: false }
      deps.nativeStepExecutor = recordingPulpitContent(pulpitTexts, 'dr_failed_error')

      const { advanced } = await advanceCreatedFlow({
        deps,
        jobsStore,
        flow: {
          sequence: [
            execStep('poll', 'process.exit(0)', { branches: { default: 'notify' } }),
            {
              id: 'notify',
              kind: 'pulpit-message',
              binding: 'agent-mneme.discord-primary',
              content:
                'code={{poll.errorCode}} message={{poll.errorMessage}} stderr={{poll.stderr}}',
            },
          ],
        },
      })

      expect(advanced.status).toBe('succeeded')
      expect(pulpitTexts).toEqual([
        'code=exec_policy_denied message=exec steps are disabled by policy stderr=',
      ])
    })
  })

  test('failed exec diagnostics remain unavailable to a target selected by another step', async () => {
    await withFlowHarness(async ({ deps, jobsStore }) => {
      const pulpitTexts: string[] = []
      deps.nativeStepExecutor = recordingPulpitContent(pulpitTexts, 'dr_unrelated')

      await advanceCreatedFlow({
        deps,
        jobsStore,
        flow: {
          sequence: [
            execStep('poll', 'console.error("secret diagnostic"); process.exit(2)', {
              branches: { default: 'route' },
            }),
            execStep('route', 'process.exit(0)', {
              branches: { exitCode: { '0': 'notify' } },
            }),
            {
              id: 'notify',
              kind: 'pulpit-message',
              binding: 'agent-mneme.discord-primary',
              content: 'diagnostic={{poll.stderr}}',
            },
          ],
        },
      })

      expect(pulpitTexts).toEqual(['diagnostic={{poll.stderr}}'])
    })
  })

  test('failed exec diagnostics remain unavailable across runs and from pending steps', async () => {
    await withFlowHarness(async ({ deps, jobsStore }) => {
      const pulpitTexts: string[] = []
      deps.nativeStepExecutor = recordingPulpitContent(pulpitTexts, 'dr_other_run')
      const job = createFlowJob(jobsStore, {
        sequence: [
          execStep('route', 'process.exit(0)', {
            branches: { exitCode: { '0': 'notify' } },
          }),
          execStep('poll', 'process.exit(0)', { branches: { default: 'notify' } }),
          {
            id: 'notify',
            kind: 'pulpit-message',
            binding: 'agent-mneme.discord-primary',
            content: 'diagnostic={{poll.stderr}}',
          },
        ],
      })
      const priorRun = createJobRun(jobsStore, job.jobId, { jobRunId: 'jrun_prior_diagnostic' })
      jobsStore.jobStepRuns.insertMany(priorRun.jobRunId, 'sequence', [
        {
          stepId: 'poll',
          status: 'failed',
          attempt: 1,
          result: execResult({ exitCode: 2, stderr: 'prior-run diagnostic' }),
          branchTaken: { kind: 'default', key: 'default', target: 'notify' },
          completedAt: '2026-04-28T12:00:01.000Z',
        },
      ])
      const currentRun = createJobRun(jobsStore, job.jobId, {
        jobRunId: 'jrun_current_diagnostic',
      })

      await advanceJobFlow({
        deps: deps as never,
        job,
        jobRun: currentRun,
        actor: { kind: 'system', id: 'flow-engine-test' },
        now: '2026-04-28T12:01:00.000Z',
      })

      expect(pulpitTexts).toEqual(['diagnostic={{poll.stderr}}'])
    })
  })

  test('failed exec diagnostics remain unavailable to structured authority refs', async () => {
    await withFlowHarness(async ({ deps, jobsStore }) => {
      const pulpitTexts: string[] = []
      deps.nativeStepExecutor = recordingPulpitContent(pulpitTexts, 'dr_structured')

      const { jobRun, advanced } = await advanceCreatedFlow({
        deps,
        jobsStore,
        flow: {
          sequence: [
            execStep('poll', 'console.error("not authority"); process.exit(2)', {
              branches: { default: 'notify' },
            }),
            {
              id: 'notify',
              kind: 'pulpit-message',
              binding: { $step: 'poll', field: 'stderr' },
              content: 'must not deliver',
            },
          ],
        },
      })

      expect(advanced.status).toBe('failed')
      expect(pulpitTexts).toEqual([])
      expect(
        jobsStore.jobStepRuns.getById(jobRun.jobRunId, 'sequence', 'notify', 1).jobStepRun?.error
          ?.message
      ).toBe('unresolved step output ref poll.stderr')
    })
  })

  test('failed exec diagnostics remain unavailable across phases', async () => {
    await withFlowHarness(async ({ deps, jobsStore }) => {
      const pulpitTexts: string[] = []
      deps.nativeStepExecutor = recordingPulpitContent(pulpitTexts, 'dr_cross_phase')

      const { advanced } = await advanceCreatedFlow({
        deps,
        jobsStore,
        flow: {
          sequence: [execStep('poll', 'console.error("cross-phase"); process.exit(2)')],
          onFailure: [
            {
              id: 'notify',
              kind: 'pulpit-message',
              binding: 'agent-mneme.discord-primary',
              content: 'diagnostic={{poll.stderr}}',
            },
          ],
        },
      })

      expect(advanced.status).toBe('failed')
      expect(pulpitTexts).toEqual(['diagnostic={{poll.stderr}}'])
    })
  })

  test('failed exec without an explicit branch never executes its implicit native successor', async () => {
    await withFlowHarness(async ({ deps, jobsStore }) => {
      const pulpitTexts: string[] = []
      deps.nativeStepExecutor = recordingPulpitContent(pulpitTexts, 'dr_implicit')

      const { advanced } = await advanceCreatedFlow({
        deps,
        jobsStore,
        flow: {
          sequence: [
            execStep('poll', 'console.error("implicit"); process.exit(2)'),
            {
              id: 'notify',
              kind: 'pulpit-message',
              binding: 'agent-mneme.discord-primary',
              content: 'diagnostic={{poll.stderr}}',
            },
          ],
        },
      })

      expect(advanced.status).toBe('failed')
      expect(pulpitTexts).toEqual([])
    })
  })
})
