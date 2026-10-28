import { describe, expect, test } from 'bun:test'
import { advanceJobFlow } from '../../src/jobs/flow-engine.js'
import {
  agentStep,
  createFlowJob,
  createJobRun,
  execResult,
  execStep,
  withFlowHarness,
} from '../fixtures/flow-engine.js'
import { hrcClientForFreshStep } from '../fixtures/flow-fresh-history.js'

describe('advanceJobFlow exec resume/replay', () => {
  // T-05416: retry state is represented by a newer step-run attempt row. The
  // engine must read that active row before dispatch so attempt 2 gets a fresh
  // idempotency key instead of colliding with stale attempt 1.
  test('step retry dispatches the active attempt 2 row with a fresh idempotency key (T-05416 red)', async () => {
    await withFlowHarness(async ({ deps, jobsStore, inputAttemptStore }) => {
      const job = createFlowJob(jobsStore, {
        sequence: [agentStep('report', 'retry report after transient dispatch failure')],
      })
      const jobRun = createJobRun(jobsStore, job.jobId, {
        jobRunId: 'jrun_retry_attempt_2_dispatch',
        status: 'claimed',
      })
      jobsStore.jobStepRuns.insertMany(jobRun.jobRunId, 'sequence', [
        {
          stepId: 'report',
          status: 'failed',
          attempt: 1,
          inputAttemptId: 'iat_stale_attempt_1',
          runId: 'run_stale_attempt_1',
          error: {
            code: 'step_dispatch_transient',
            message:
              'different request body already exists for idempotencyKey jobrun:jrun_retry_attempt_2_dispatch:phase:sequence:step:report:attempt:1',
          },
          startedAt: '2026-04-28T12:00:00.000Z',
          completedAt: '2026-04-28T12:00:10.000Z',
        },
        { stepId: 'report', status: 'pending', attempt: 2 },
      ])

      const advanced = await advanceJobFlow({
        deps: deps as never,
        job,
        jobRun,
        actor: { kind: 'system', id: 'flow-engine-test' },
        now: '2026-04-28T12:01:00.000Z',
      })

      expect(inputAttemptStore.calls.map((call) => call.idempotencyKey)).toEqual([
        'jobrun:jrun_retry_attempt_2_dispatch:phase:sequence:step:report:attempt:2',
      ])
      expect(advanced.status).toBe('succeeded')
      expect(inputAttemptStore.calls[0]?.metadata?.source).toMatchObject({
        jobRunId: 'jrun_retry_attempt_2_dispatch',
        stepId: 'report',
        phase: 'sequence',
        attempt: 2,
      })
      expect(
        jobsStore.jobStepRuns.getById(jobRun.jobRunId, 'sequence', 'report', 2).jobStepRun
      ).toMatchObject({
        status: 'succeeded',
        inputAttemptId: expect.any(String),
        runId: expect.any(String),
      })
    })
  })

  // T-05416: scheduled-fresh lookup must scan the active dispatched attempt for
  // a prior job run; attempt 1 can be a stale failed retry predecessor.
  test('scheduled fresh cleanup finds the prior dispatched attempt 2 instead of stale attempt 1 (T-05416 red)', async () => {
    await withFlowHarness(async ({ deps, jobsStore, order }) => {
      const job = createFlowJob(jobsStore, {
        sequence: [
          {
            id: 'fresh-start',
            input: 'start with fresh context',
            fresh: true,
          },
        ],
      })

      const priorRun = deps.runStore.createRun({
        sessionRef: { scopeRef: job.scopeRef, laneRef: job.laneRef },
        status: 'completed',
      })
      deps.runStore.updateRun(priorRun.runId, {
        status: 'completed',
        hrcRunId: `hrc-${priorRun.runId}`,
        hostSessionId: 'hsid-prior-attempt-2',
        runtimeId: 'rt-prior-attempt-2',
      })
      const priorJobRun = createJobRun(jobsStore, job.jobId, {
        jobRunId: 'jrun_prior_fresh_attempt_2',
        triggeredAt: '2026-04-28T12:00:00.000Z',
        triggeredBy: 'schedule',
        status: 'succeeded',
        completedAt: '2026-04-28T12:05:00.000Z',
      })
      jobsStore.jobStepRuns.insertMany(priorJobRun.jobRunId, 'sequence', [
        {
          stepId: 'fresh-start',
          status: 'failed',
          attempt: 1,
          startedAt: '2026-04-28T12:00:00.000Z',
          completedAt: '2026-04-28T12:01:00.000Z',
        },
        {
          stepId: 'fresh-start',
          status: 'succeeded',
          attempt: 2,
          runId: priorRun.runId,
          startedAt: '2026-04-28T12:02:00.000Z',
          completedAt: '2026-04-28T12:05:00.000Z',
        },
      ])

      const currentJobRun = createJobRun(jobsStore, job.jobId, {
        jobRunId: 'jrun_current_fresh_attempt_2',
        triggeredAt: '2026-04-28T12:20:00.000Z',
        triggeredBy: 'schedule',
        status: 'claimed',
      })
      const terminateCalls: Array<{ runtimeId: string; options: unknown }> = []

      const advanced = await advanceJobFlow({
        deps: {
          ...deps,
          hrcClient: hrcClientForFreshStep({
            order,
            terminateCalls,
          }),
        } as never,
        job,
        jobRun: currentJobRun,
        actor: { kind: 'system', id: 'flow-engine-test' },
        now: '2026-04-28T12:21:00.000Z',
      })

      expect(advanced.status).toBe('succeeded')
      expect(terminateCalls.map((call) => call.runtimeId)).toEqual(['rt-prior-attempt-2'])
      expect(order).toEqual([
        'terminate:rt-prior-attempt-2',
        'resolveSession',
        'clearContext',
        'dispatch',
      ])
    })
  })

  // T-05416: skip/reconcile helpers must update the current attempt's remaining
  // rows. Updating only attempt 1 leaves retry attempt 2 runnable after failure.
  test('failure reconciliation skips remaining sequence rows on the current attempt, not stale attempt 1 (T-05416 red)', async () => {
    await withFlowHarness(async ({ deps, jobsStore, inputAttemptStore }) => {
      const job = createFlowJob(jobsStore, {
        sequence: [
          execStep('probe', 'process.exit(1)'),
          agentStep('report', 'must be skipped on retry attempt failure'),
        ],
      })
      const jobRun = createJobRun(jobsStore, job.jobId, {
        jobRunId: 'jrun_retry_attempt_2_skip_remaining',
        status: 'claimed',
      })
      jobsStore.jobStepRuns.insertMany(jobRun.jobRunId, 'sequence', [
        {
          stepId: 'probe',
          status: 'succeeded',
          attempt: 1,
          result: execResult({ exitCode: 0 }),
          completedAt: '2026-04-28T12:00:10.000Z',
        },
        {
          stepId: 'probe',
          status: 'failed',
          attempt: 2,
          result: execResult({ exitCode: 1 }),
          completedAt: '2026-04-28T12:01:10.000Z',
        },
        {
          stepId: 'report',
          status: 'pending',
          attempt: 2,
        },
      ])

      const advanced = await advanceJobFlow({
        deps: deps as never,
        job,
        jobRun,
        actor: { kind: 'system', id: 'flow-engine-test' },
        now: '2026-04-28T12:02:00.000Z',
      })

      expect(advanced.status).toBe('failed')
      expect(inputAttemptStore.calls).toHaveLength(0)
      expect(
        jobsStore.jobStepRuns.getById(jobRun.jobRunId, 'sequence', 'report', 2).jobStepRun
      ).toMatchObject({
        status: 'skipped',
        completedAt: '2026-04-28T12:02:00.000Z',
      })
    })
  })

  test('resume re-resolves a failed exec result_json branch and advances to the target step', async () => {
    await withFlowHarness(async ({ deps, jobsStore, inputAttemptStore, launchCalls }) => {
      const job = createFlowJob(jobsStore, {
        sequence: [
          execStep('probe', 'process.exit(1)', {
            branches: { exitCode: { '1': 'report' } },
          }),
          agentStep('report', 'resume selected branch target'),
        ],
      })
      const jobRun = createJobRun(jobsStore, job.jobId)
      jobsStore.jobStepRuns.insertMany(jobRun.jobRunId, 'sequence', [
        {
          stepId: 'probe',
          status: 'failed',
          attempt: 1,
          result: execResult({ exitCode: 1 }),
          completedAt: '2026-04-28T12:00:10.000Z',
        },
        { stepId: 'report', status: 'pending', attempt: 1 },
      ])

      const advanced = await advanceJobFlow({
        deps: deps as never,
        job,
        jobRun,
        actor: { kind: 'system', id: 'flow-engine-test' },
        now: '2026-04-28T12:01:00.000Z',
      })

      expect(advanced.status).toBe('succeeded')
      expect(inputAttemptStore.calls.map((call) => call.content)).toEqual([
        'resume selected branch target',
      ])
      expect(launchCalls).toHaveLength(1)
      expect(
        jobsStore.jobStepRuns
          .listByJobRun(jobRun.jobRunId)
          .jobStepRuns.map((step) => [step.stepId, step.status])
      ).toEqual([
        ['probe', 'failed'],
        ['report', 'succeeded'],
      ])
    })
  })

  test('resume fails a previous non-zero exec result with no matching branch and runs onFailure', async () => {
    await withFlowHarness(async ({ deps, jobsStore, inputAttemptStore }) => {
      const job = createFlowJob(jobsStore, {
        sequence: [
          execStep('probe', 'process.exit(1)'),
          agentStep('report', 'must not run without a matching exec branch'),
        ],
        onFailure: [agentStep('cleanup', 'cleanup after resumed exec failure')],
      })
      const jobRun = createJobRun(jobsStore, job.jobId)
      jobsStore.jobStepRuns.insertMany(jobRun.jobRunId, 'sequence', [
        {
          stepId: 'probe',
          status: 'failed',
          attempt: 1,
          result: execResult({ exitCode: 1 }),
          completedAt: '2026-04-28T12:00:10.000Z',
        },
        { stepId: 'report', status: 'pending', attempt: 1 },
      ])

      const advanced = await advanceJobFlow({
        deps: deps as never,
        job,
        jobRun,
        actor: { kind: 'system', id: 'flow-engine-test' },
        now: '2026-04-28T12:01:00.000Z',
      })

      expect(advanced.status).toBe('failed')
      expect(inputAttemptStore.calls.map((call) => call.content)).toEqual([
        'cleanup after resumed exec failure',
      ])
      expect(
        jobsStore.jobStepRuns
          .listByJobRun(jobRun.jobRunId)
          .jobStepRuns.map((step) => [step.phase, step.stepId, step.status])
      ).toEqual([
        ['sequence', 'probe', 'failed'],
        ['sequence', 'report', 'skipped'],
        ['onFailure', 'cleanup', 'succeeded'],
      ])
    })
  })

  test('failed exec step promotes the captured reason to the job run error message', async () => {
    await withFlowHarness(async ({ deps, jobsStore }) => {
      const job = createFlowJob(jobsStore, {
        sequence: [
          execStep(
            'select_refactor_task',
            [
              'console.log("selected T-05791")',
              'console.log("Worktree is dirty after selecting a task; skipping agent dispatch.")',
              'console.log(" M package.json")',
              'console.log("?? refactor-analysis/legibility-extract-acp-adoption-probe-report.md")',
              'process.exit(1)',
            ].join(';')
          ),
          agentStep('run', 'must not dispatch after failed exec gate'),
        ],
      })
      const jobRun = createJobRun(jobsStore, job.jobId)

      const advanced = await advanceJobFlow({
        deps: deps as never,
        job,
        jobRun,
        actor: { kind: 'system', id: 'flow-engine-test' },
        now: '2026-04-28T12:01:00.000Z',
      })

      expect(advanced.status).toBe('failed')
      expect(advanced.errorCode).toBe('exec_exit_code')
      expect(advanced.errorMessage).toBe(
        'sequence step select_refactor_task failed: exec step exit 1: Worktree is dirty after selecting a task; skipping agent dispatch.'
      )
    })
  })
})
