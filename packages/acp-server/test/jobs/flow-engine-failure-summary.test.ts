import { describe, expect, test } from 'bun:test'
import {
  type FlowEngineDeps,
  advanceCreatedFlow,
  agentStep,
  execStep,
  withFlowHarness,
} from '../fixtures/flow-engine.js'

// Characterization (T-12460): how a failed exec step becomes the job run's
// errorCode/errorMessage, and which step error codes exec failures carry.
async function runFailingExec(
  code: string,
  overrideDeps: (deps: FlowEngineDeps) => FlowEngineDeps = (deps) => deps,
  argv?: string[]
) {
  return withFlowHarness(async ({ deps, jobsStore, inputAttemptStore }) => {
    const step = execStep('gate', code)
    const { jobRun, advanced } = await advanceCreatedFlow({
      deps: overrideDeps(deps),
      jobsStore,
      flow: {
        sequence: [
          argv === undefined ? step : { ...step, exec: { argv } },
          agentStep('after', 'must not dispatch after a failed exec gate'),
        ],
      },
    })
    expect(inputAttemptStore.calls).toHaveLength(0)
    return {
      step: jobsStore.jobStepRuns.getById(jobRun.jobRunId, 'sequence', 'gate', 1).jobStepRun,
      job: advanced,
    }
  })
}

describe('advanceJobFlow exec failure summary', () => {
  test('a signal-terminated exec reports the signal and last output line', async () => {
    const { step, job } = await runFailingExec(
      'console.log("starting"); console.log("about to stop"); process.kill(process.pid, "SIGTERM")'
    )

    expect(step).toMatchObject({
      status: 'failed',
      result: expect.objectContaining({ exitCode: null, signal: 'SIGTERM', timedOut: false }),
    })
    expect(job).toMatchObject({
      status: 'failed',
      errorCode: 'exec_exit_code',
      errorMessage: 'sequence step gate failed: exec step signal SIGTERM: about to stop',
    })
  })

  test('a diagnostic stderr line wins over later plain stdout', async () => {
    const { job } = await runFailingExec(
      'console.error("fatal: permission denied for repo"); console.error("cleanup done"); console.log("bye"); process.exit(3)'
    )

    expect(job.errorMessage).toBe(
      'sequence step gate failed: exec step exit 3: fatal: permission denied for repo'
    )
  })

  test('silent non-zero exit reports only the exit code', async () => {
    const { job } = await runFailingExec('process.exit(7)')

    expect(job).toMatchObject({
      errorCode: 'exec_exit_code',
      errorMessage: 'sequence step gate failed: exec step exit 7',
    })
  })

  test('long failure messages truncate to 1024 characters', async () => {
    const { job } = await runFailingExec(
      `console.error("error: " + "x".repeat(2000)); process.exit(1)`
    )

    const message = job.errorMessage ?? ''
    expect(message).toHaveLength(1024)
    expect(message.startsWith('sequence step gate failed: exec step exit 1: error: xxx')).toBe(true)
    expect(message.endsWith('x...')).toBe(true)
  })

  test('an exec timeout fails the step and job with exec_timeout', async () => {
    const { step, job } = await runFailingExec('setTimeout(() => {}, 5000)', (deps) => ({
      ...deps,
      jobExecPolicy: {
        ...(deps.jobExecPolicy as NonNullable<FlowEngineDeps['jobExecPolicy']>),
        defaultTimeoutMs: 100,
        maxTimeoutMs: 100,
      },
    }))

    expect(step).toMatchObject({
      status: 'failed',
      error: { code: 'exec_timeout', message: 'exec step timed out' },
      result: expect.objectContaining({ timedOut: true, exitCode: null }),
    })
    expect(job).toMatchObject({ errorCode: 'exec_timeout', errorMessage: 'exec step timed out' })
  })

  test('an unspawnable command fails exec_spawn_failed', async () => {
    const { step, job } = await runFailingExec('', undefined, [
      '/nonexistent/acp-flow-engine-command',
    ])

    expect(step).toMatchObject({
      status: 'failed',
      error: expect.objectContaining({ code: 'exec_spawn_failed' }),
      completedAt: '2026-04-28T12:01:00.000Z',
    })
    expect(job.errorCode).toBe('exec_spawn_failed')
  })

  test('a placement resolution error fails exec_spawn_failed with its message', async () => {
    const { step, job } = await runFailingExec('process.exit(0)', (deps) => ({
      ...deps,
      runtimeResolver: async () => {
        throw new Error('placement unavailable for scope')
      },
    }))

    expect(step).toMatchObject({
      status: 'failed',
      error: { code: 'exec_spawn_failed', message: 'placement unavailable for scope' },
    })
    expect(job).toMatchObject({
      errorCode: 'exec_spawn_failed',
      errorMessage: 'placement unavailable for scope',
    })
  })
})
