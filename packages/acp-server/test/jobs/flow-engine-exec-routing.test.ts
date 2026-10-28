import { describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FLOW_JOB_SCOPE_REF,
  advanceCreatedFlow,
  agentStep,
  execStep,
  withFlowHarness,
} from '../fixtures/flow-engine.js'

describe('advanceJobFlow exec steps', () => {
  test('T-05421 exec cwd policy implicitly allows the scope-resolved placement root', async () => {
    await withFlowHarness(async ({ deps, jobsStore }) => {
      const placementRoot = mkdtempSync(join(tmpdir(), 'acp-flow-placement-'))
      const physicalPlacementRoot = realpathSync(placementRoot)

      try {
        const { job, jobRun, advanced } = await advanceCreatedFlow({
          deps: {
            ...deps,
            runtimeResolver: async () => ({
              agentRoot: join(placementRoot, '.agents', 'larry'),
              projectRoot: placementRoot,
              cwd: placementRoot,
              runMode: 'task',
              bundle: { kind: 'compose', compose: [] },
              harness: { provider: 'openai', interactive: true },
            }),
            jobExecPolicy: {
              ...deps.jobExecPolicy,
              // T-05421: server-global roots may be pinned to another checkout.
              // The scoped placement root must still be allowed for this job.
              allowedCwdRoots: [join(placementRoot, '..', 'agent-control-plane-only')],
            },
          },
          jobsStore,
          flow: {
            sequence: [
              execStep('pwd', 'process.stdout.write(process.cwd())'),
              agentStep('report', 'report after scoped exec success'),
            ],
          },
        })

        const stepRun = jobsStore.jobStepRuns.getById(
          jobRun.jobRunId,
          'sequence',
          'pwd',
          1
        ).jobStepRun
        expect(stepRun).toMatchObject({
          status: 'succeeded',
          result: expect.objectContaining({
            kind: 'exec',
            cwd: placementRoot,
            stdout: physicalPlacementRoot,
          }),
        })
        expect(advanced.status).toBe('succeeded')
        expect(job.scopeRef).toBe(FLOW_JOB_SCOPE_REF)
      } finally {
        rmSync(placementRoot, { recursive: true, force: true })
      }
    })
  })

  test('exec exit 0 continues to the next step in the same call', async () => {
    await withFlowHarness(async ({ deps, jobsStore, inputAttemptStore, launchCalls }) => {
      const { jobRun, advanced } = await advanceCreatedFlow({
        deps,
        jobsStore,
        flow: {
          sequence: [
            execStep('probe', 'process.exit(0)'),
            agentStep('report', 'report after exec success'),
          ],
        },
      })

      const steps = jobsStore.jobStepRuns.listByJobRun(jobRun.jobRunId).jobStepRuns
      expect(advanced.status).toBe('succeeded')
      expect(steps.map((step) => [step.stepId, step.status])).toEqual([
        ['probe', 'succeeded'],
        ['report', 'succeeded'],
      ])
      expect(steps[0]).toMatchObject({
        inputAttemptId: undefined,
        runId: undefined,
        result: expect.objectContaining({ kind: 'exec', exitCode: 0 }),
      })
      expect(inputAttemptStore.calls.map((call) => call.content)).toEqual([
        'report after exec success',
      ])
      expect(launchCalls).toHaveLength(1)
    })
  })

  test('exec non-zero without a branch fails the sequence and runs onFailure', async () => {
    await withFlowHarness(async ({ deps, jobsStore, inputAttemptStore }) => {
      const { jobRun, advanced } = await advanceCreatedFlow({
        deps,
        jobsStore,
        flow: {
          sequence: [
            execStep('probe', 'process.exit(1)'),
            agentStep('never', 'must be skipped after unhandled exec failure'),
          ],
          onFailure: [agentStep('cleanup', 'cleanup after exec failure')],
        },
      })

      expect(advanced.status).toBe('failed')
      expect(inputAttemptStore.calls.map((call) => call.content)).toEqual([
        'cleanup after exec failure',
      ])
      expect(
        jobsStore.jobStepRuns
          .listByJobRun(jobRun.jobRunId)
          .jobStepRuns.map((step) => [step.phase, step.stepId, step.status])
      ).toEqual([
        ['sequence', 'probe', 'failed'],
        ['sequence', 'never', 'skipped'],
        ['onFailure', 'cleanup', 'succeeded'],
      ])
    })
  })

  test('exec non-zero with branches.exitCode jumps to the named step', async () => {
    await withFlowHarness(async ({ deps, jobsStore, inputAttemptStore }) => {
      const { jobRun, advanced } = await advanceCreatedFlow({
        deps,
        jobsStore,
        flow: {
          sequence: [
            execStep('probe', 'process.exit(1)', {
              branches: { exitCode: { '1': 'report' } },
            }),
            agentStep('ignored', 'should not run when exec jumps over it'),
            agentStep('report', 'report selected exec branch'),
          ],
        },
      })

      expect(advanced.status).toBe('succeeded')
      expect(inputAttemptStore.calls.map((call) => call.content)).toEqual([
        'report selected exec branch',
      ])
      expect(
        jobsStore.jobStepRuns
          .listByJobRun(jobRun.jobRunId)
          .jobStepRuns.map((step) => [step.stepId, step.status])
      ).toEqual([
        ['probe', 'failed'],
        ['ignored', 'pending'],
        ['report', 'succeeded'],
      ])
    })
  })

  test('exec branches.default is used when no exitCode branch matches', async () => {
    await withFlowHarness(async ({ deps, jobsStore, inputAttemptStore }) => {
      const { advanced } = await advanceCreatedFlow({
        deps,
        jobsStore,
        flow: {
          sequence: [
            execStep('probe', 'process.exit(7)', {
              branches: { exitCode: { '1': 'fail' }, default: 'report' },
            }),
            agentStep('report', 'report selected default branch'),
          ],
        },
      })

      expect(advanced.status).toBe('succeeded')
      expect(inputAttemptStore.calls.map((call) => call.content)).toEqual([
        'report selected default branch',
      ])
    })
  })

  test('exec branch to succeed marks the job run succeeded', async () => {
    await withFlowHarness(async ({ deps, jobsStore, inputAttemptStore }) => {
      const { jobRun, advanced } = await advanceCreatedFlow({
        deps,
        jobsStore,
        flow: {
          sequence: [
            execStep('probe', 'process.exit(0)', {
              branches: { exitCode: { '0': 'succeed' } },
            }),
            agentStep('never', 'must not run after branch succeeds'),
          ],
        },
      })

      expect(advanced.status).toBe('succeeded')
      expect(inputAttemptStore.calls).toHaveLength(0)
      expect(
        jobsStore.jobStepRuns
          .listByJobRun(jobRun.jobRunId)
          .jobStepRuns.map((step) => [step.stepId, step.status])
      ).toEqual([
        ['probe', 'succeeded'],
        ['never', 'pending'],
      ])
    })
  })

  test('exec configured success exit code can skip the agent step without a failed step', async () => {
    await withFlowHarness(async ({ deps, jobsStore, inputAttemptStore }) => {
      const { jobRun, advanced } = await advanceCreatedFlow({
        deps,
        jobsStore,
        flow: {
          sequence: [
            execStep('selector', 'process.exit(10)', {
              exec: {
                argv: [process.execPath, '-e', 'process.exit(10)'],
                successExitCodes: [0, 10],
              },
              branches: { exitCode: { '10': 'succeed' }, default: 'run' },
            }),
            agentStep('run', 'must not run when selector exits no-work'),
          ],
        },
      })

      expect(advanced.status).toBe('succeeded')
      expect(inputAttemptStore.calls).toHaveLength(0)
      expect(
        jobsStore.jobStepRuns
          .listByJobRun(jobRun.jobRunId)
          .jobStepRuns.map((step) => [step.stepId, step.status])
      ).toEqual([
        ['selector', 'succeeded'],
        ['run', 'pending'],
      ])
    })
  })

  test('exec branch to fail marks the job run failed', async () => {
    await withFlowHarness(async ({ deps, jobsStore, inputAttemptStore }) => {
      const { advanced } = await advanceCreatedFlow({
        deps,
        jobsStore,
        flow: {
          sequence: [
            execStep('probe', 'process.exit(0)', {
              branches: { exitCode: { '0': 'fail' } },
            }),
            agentStep('never', 'must not run after branch fails'),
          ],
        },
      })

      expect(advanced.status).toBe('failed')
      expect(inputAttemptStore.calls).toHaveLength(0)
    })
  })
})
describe('preserved flow branch and incident', () => {
  test('exec step leaves inputAttemptId and runId unset', async () => {
    await withFlowHarness(async ({ deps, jobsStore }) => {
      const { jobRun } = await advanceCreatedFlow({
        deps,
        jobsStore,
        flow: {
          sequence: [
            execStep('probe', 'process.exit(0)', {
              branches: { exitCode: { '0': 'succeed' } },
            }),
          ],
        },
      })

      const step = jobsStore.jobStepRuns.getById(jobRun.jobRunId, 'sequence', 'probe', 1).jobStepRun
      expect(step).toMatchObject({
        status: 'succeeded',
        inputAttemptId: undefined,
        runId: undefined,
      })
    })
  })
})
