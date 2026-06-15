import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createInMemoryJobsStore } from 'acp-jobs-store'
import { type AcpServerDeps, InMemoryRunStore } from 'acp-server'

import {
  type FlowLaunchOutcome,
  type LaunchCall,
  RecordingInputAttemptStore,
  createFlowJob as createFlowJobBase,
  createHeadlessHrcDb as createHeadlessHrcDbBase,
  createTerminalFlowLauncher as createTerminalFlowLauncherBase,
  getJobRun,
  runJob,
} from './fixtures/jobflow-stack.js'
import { type SeedStack, withSeedStack } from './fixtures/seed-stack.js'

const EXEC_HRC_PREFIX = 'acp-e2e-jobflow-exec-'
const EXEC_SESSION_ID = 'session-jobflow-exec-e2e'
const EXEC_SCOPE_REF_TASK = 'T-01321'
const EXEC_JOB_CONTENT = 'run the jobflow exec acceptance test'

function createHeadlessHrcDb() {
  return createHeadlessHrcDbBase(EXEC_HRC_PREFIX)
}

function createTerminalFlowLauncher(
  hrc: Parameters<typeof createTerminalFlowLauncherBase>[0],
  outcomes: FlowLaunchOutcome[],
  calls: LaunchCall[]
): NonNullable<AcpServerDeps['launchRoleScopedRun']> {
  return createTerminalFlowLauncherBase(hrc, outcomes, calls, { sessionId: EXEC_SESSION_ID })
}

async function createFlowJob(stack: SeedStack, flow: Record<string, unknown>): Promise<string> {
  return createFlowJobBase(stack, flow, {
    scopeRefTask: EXEC_SCOPE_REF_TASK,
    content: EXEC_JOB_CONTENT,
  })
}

function createRuntimeResolver(cwd: string): NonNullable<AcpServerDeps['runtimeResolver']> {
  return async (sessionRef) => ({
    agentRoot: `/tmp/${sessionRef.scopeRef.replace(/[^a-zA-Z0-9_-]+/g, '-')}`,
    projectRoot: cwd,
    cwd,
    runMode: 'task',
    bundle: { kind: 'compose', compose: [] },
    harness: { provider: 'openai', interactive: true, model: 'gpt-5-codex' },
  })
}

const EXEC_TIMEOUT_MS = '5000'

async function withExecEnv<T>(
  cwd: string,
  enabled: boolean,
  run: () => Promise<T> | T
): Promise<T> {
  const original = {
    enabled: process.env['ACP_JOB_FLOW_EXEC_ENABLED'],
    allowedCwdRoots: process.env['ACP_JOB_FLOW_EXEC_ALLOWED_CWD_ROOTS'],
    defaultTimeoutMs: process.env['ACP_JOB_FLOW_EXEC_DEFAULT_TIMEOUT_MS'],
    maxTimeoutMs: process.env['ACP_JOB_FLOW_EXEC_MAX_TIMEOUT_MS'],
  }

  if (enabled) {
    process.env['ACP_JOB_FLOW_EXEC_ENABLED'] = '1'
  } else {
    Reflect.deleteProperty(process.env, 'ACP_JOB_FLOW_EXEC_ENABLED')
  }
  process.env['ACP_JOB_FLOW_EXEC_ALLOWED_CWD_ROOTS'] = cwd
  process.env['ACP_JOB_FLOW_EXEC_DEFAULT_TIMEOUT_MS'] = EXEC_TIMEOUT_MS
  process.env['ACP_JOB_FLOW_EXEC_MAX_TIMEOUT_MS'] = EXEC_TIMEOUT_MS

  try {
    return await run()
  } finally {
    restoreEnv('ACP_JOB_FLOW_EXEC_ENABLED', original.enabled)
    restoreEnv('ACP_JOB_FLOW_EXEC_ALLOWED_CWD_ROOTS', original.allowedCwdRoots)
    restoreEnv('ACP_JOB_FLOW_EXEC_DEFAULT_TIMEOUT_MS', original.defaultTimeoutMs)
    restoreEnv('ACP_JOB_FLOW_EXEC_MAX_TIMEOUT_MS', original.maxTimeoutMs)
  }
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key)
  } else {
    process.env[key] = value
  }
}

function execStep(id: string, code: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    kind: 'exec',
    exec: {
      argv: [process.execPath, '-e', code],
    },
    ...extra,
  }
}

describe('jobflow-exec e2e', () => {
  test('exec exit 0 branches through a second exec step and succeeds with captured results', async () => {
    const jobsStore = createInMemoryJobsStore()
    const runStore = new InMemoryRunStore()
    const inputAttemptStore = new RecordingInputAttemptStore()
    const hrc = createHeadlessHrcDb()
    const cwd = mkdtempSync(join(tmpdir(), 'acp-e2e-jobflow-exec-cwd-'))
    const launchCalls: LaunchCall[] = []

    try {
      await withExecEnv(cwd, true, async () => {
        await withSeedStack(
          async (stack) => {
            const jobId = await createFlowJob(stack, {
              sequence: [
                execStep('hello', 'process.stdout.write("hello"); process.exit(0)', {
                  branches: { exitCode: { '0': 'second' } },
                }),
                execStep('second', 'process.stdout.write("done"); process.exit(0)', {
                  next: 'fail',
                  branches: { exitCode: { '0': 'succeed' } },
                }),
              ],
            })

            const jobRunId = await runJob(stack, jobId)
            const payload = await getJobRun(stack, jobRunId)
            const steps = payload.jobRun.steps

            expect(payload.jobRun.status).toBe('succeeded')
            expect(steps.map((step) => [step.phase, step.stepId, step.status])).toEqual([
              ['sequence', 'hello', 'succeeded'],
              ['sequence', 'second', 'succeeded'],
            ])
            expect(steps[0]).toMatchObject({
              attempt: 1,
              result: expect.objectContaining({
                kind: 'exec',
                argv: [process.execPath, '-e', 'process.stdout.write("hello"); process.exit(0)'],
                cwd,
                exitCode: 0,
                stdout: 'hello',
                stderr: '',
                timedOut: false,
              }),
            })
            expect(steps[0]?.inputAttemptId).toBeUndefined()
            expect(steps[0]?.runId).toBeUndefined()
            expect(steps[1]).toMatchObject({
              attempt: 1,
              result: expect.objectContaining({
                kind: 'exec',
                exitCode: 0,
                stdout: 'done',
                timedOut: false,
              }),
            })
            expect(inputAttemptStore.calls).toHaveLength(0)
            expect(launchCalls).toHaveLength(0)
          },
          {
            jobsStore,
            runStore,
            inputAttemptStore,
            hrcDbPath: hrc.hrcDbPath,
            runtimeResolver: createRuntimeResolver(cwd),
            launchRoleScopedRun: createTerminalFlowLauncher(hrc, [], launchCalls),
          }
        )
      })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
      hrc.cleanup()
      jobsStore.close()
    }
  })

  test('exec exit 1 follows an exitCode branch to an agent step before the job fails', async () => {
    const jobsStore = createInMemoryJobsStore()
    const runStore = new InMemoryRunStore()
    const inputAttemptStore = new RecordingInputAttemptStore()
    const hrc = createHeadlessHrcDb()
    const cwd = mkdtempSync(join(tmpdir(), 'acp-e2e-jobflow-exec-cwd-'))
    const launchCalls: LaunchCall[] = []

    try {
      await withExecEnv(cwd, true, async () => {
        await withSeedStack(
          async (stack) => {
            const jobId = await createFlowJob(stack, {
              sequence: [
                execStep('probe', 'process.stderr.write("nope"); process.exit(1)', {
                  branches: { exitCode: { '1': 'report' } },
                }),
                {
                  id: 'report',
                  input: 'Report the failed exec result.',
                  next: 'fail',
                  expect: {
                    outcome: 'succeeded',
                    resultBlock: 'REPORT_RESULT',
                    require: ['reported'],
                    equals: { reported: true },
                  },
                },
              ],
            })

            const jobRunId = await runJob(stack, jobId)
            const payload = await getJobRun(stack, jobRunId)
            const steps = payload.jobRun.steps

            expect(payload.jobRun.status).toBe('failed')
            expect(steps.map((step) => [step.phase, step.stepId, step.status])).toEqual([
              ['sequence', 'probe', 'failed'],
              ['sequence', 'report', 'succeeded'],
            ])
            expect(steps[0]).toMatchObject({
              result: expect.objectContaining({
                kind: 'exec',
                exitCode: 1,
                stdout: '',
                stderr: 'nope',
                timedOut: false,
              }),
            })
            expect(steps[0]?.error).toBeUndefined()
            expect(steps[1]).toMatchObject({
              inputAttemptId: expect.any(String),
              runId: expect.any(String),
              resultBlock: 'REPORT_RESULT',
              result: { reported: true },
            })
            expect(inputAttemptStore.calls.map((call) => call.content)).toEqual([
              'Report the failed exec result.',
            ])
            expect(launchCalls).toHaveLength(1)
          },
          {
            jobsStore,
            runStore,
            inputAttemptStore,
            hrcDbPath: hrc.hrcDbPath,
            runtimeResolver: createRuntimeResolver(cwd),
            launchRoleScopedRun: createTerminalFlowLauncher(
              hrc,
              [{ status: 'completed', text: 'REPORT_RESULT\n{"reported":true}' }],
              launchCalls
            ),
          }
        )
      })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
      hrc.cleanup()
      jobsStore.close()
    }
  })

  test('exec steps are denied when ACP_JOB_FLOW_EXEC_ENABLED is not set', async () => {
    const jobsStore = createInMemoryJobsStore()
    const runStore = new InMemoryRunStore()
    const inputAttemptStore = new RecordingInputAttemptStore()
    const hrc = createHeadlessHrcDb()
    const cwd = mkdtempSync(join(tmpdir(), 'acp-e2e-jobflow-exec-cwd-'))
    const launchCalls: LaunchCall[] = []

    try {
      await withExecEnv(cwd, false, async () => {
        await withSeedStack(
          async (stack) => {
            const jobId = await createFlowJob(stack, {
              sequence: [execStep('denied', 'process.exit(0)')],
            })

            const jobRunId = await runJob(stack, jobId)
            const payload = await getJobRun(stack, jobRunId)
            const steps = payload.jobRun.steps

            expect(payload.jobRun.status).toBe('failed')
            expect(payload.jobRun.errorCode).toBe('exec_policy_denied')
            expect(steps.map((step) => [step.phase, step.stepId, step.status])).toEqual([
              ['sequence', 'denied', 'failed'],
            ])
            expect(steps[0]).toMatchObject({
              error: {
                code: 'exec_policy_denied',
                message: 'exec steps are disabled by policy',
              },
            })
            expect(steps[0]?.result).toBeUndefined()
            expect(inputAttemptStore.calls).toHaveLength(0)
            expect(launchCalls).toHaveLength(0)
          },
          {
            jobsStore,
            runStore,
            inputAttemptStore,
            hrcDbPath: hrc.hrcDbPath,
            runtimeResolver: createRuntimeResolver(cwd),
            launchRoleScopedRun: createTerminalFlowLauncher(hrc, [], launchCalls),
          }
        )
      })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
      hrc.cleanup()
      jobsStore.close()
    }
  })
})
