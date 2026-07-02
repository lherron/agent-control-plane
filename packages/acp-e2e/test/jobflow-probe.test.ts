import { describe, expect, test } from 'bun:test'

import { createInMemoryJobsStore } from 'acp-jobs-store'
import { type AcpServerDeps, InMemoryRunStore } from 'acp-server'

import {
  type FlowLaunchOutcome,
  type LaunchCall,
  RecordingInputAttemptStore,
  createFlowJob as createFlowJobBase,
  createHeadlessHrcDb,
  createTerminalFlowLauncher,
  getJobRun,
  runJob,
} from './fixtures/jobflow-stack.js'
import { type SeedStack, withSeedStack } from './fixtures/seed-stack.js'

const PROBE_SCOPE_REF_TASK = 'T-05417'
const PROBE_JOB_CONTENT = 'run the native probe acceptance test'

async function createFlowJob(stack: SeedStack, flow: Record<string, unknown>): Promise<string> {
  return createFlowJobBase(stack, flow, {
    scopeRefTask: PROBE_SCOPE_REF_TASK,
    content: PROBE_JOB_CONTENT,
  })
}

function createRuntimeResolver(): NonNullable<AcpServerDeps['runtimeResolver']> {
  return async (sessionRef) => ({
    agentRoot: `/tmp/${sessionRef.scopeRef.replace(/[^a-zA-Z0-9_-]+/g, '-')}`,
    projectRoot: process.cwd(),
    cwd: process.cwd(),
    runMode: 'task',
    bundle: { kind: 'compose', compose: [] },
    harness: { provider: 'openai', interactive: true, model: 'gpt-5-codex' },
  })
}

function createTerminalLauncher(
  hrc: ReturnType<typeof createHeadlessHrcDb>,
  outcomes: FlowLaunchOutcome[],
  calls: LaunchCall[]
): NonNullable<AcpServerDeps['launchRoleScopedRun']> {
  return createTerminalFlowLauncher(hrc, outcomes, calls, {
    sessionId: 'session-jobflow-probe-e2e',
  })
}

async function withExecEnabled<T>(run: () => Promise<T> | T): Promise<T> {
  const original = {
    enabled: process.env['ACP_JOB_FLOW_EXEC_ENABLED'],
    allowedCwdRoots: process.env['ACP_JOB_FLOW_EXEC_ALLOWED_CWD_ROOTS'],
    defaultTimeoutMs: process.env['ACP_JOB_FLOW_EXEC_DEFAULT_TIMEOUT_MS'],
    maxTimeoutMs: process.env['ACP_JOB_FLOW_EXEC_MAX_TIMEOUT_MS'],
  }

  process.env['ACP_JOB_FLOW_EXEC_ENABLED'] = '1'
  process.env['ACP_JOB_FLOW_EXEC_ALLOWED_CWD_ROOTS'] = process.cwd()
  process.env['ACP_JOB_FLOW_EXEC_DEFAULT_TIMEOUT_MS'] = '5000'
  process.env['ACP_JOB_FLOW_EXEC_MAX_TIMEOUT_MS'] = '5000'

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

function probeStep(name: string) {
  return {
    id: 'gate',
    kind: 'probe',
    probe: { name },
    branches: { outcome: { idle: 'succeed', work: 'reap' } },
  }
}

describe('jobflow-probe e2e', () => {
  test('scheduled probe idle succeeds without dispatching an agent turn', async () => {
    const jobsStore = createInMemoryJobsStore()
    const runStore = new InMemoryRunStore()
    const inputAttemptStore = new RecordingInputAttemptStore()
    const hrc = createHeadlessHrcDb('acp-e2e-jobflow-probe-')
    const launchCalls: LaunchCall[] = []
    const hrcProbeCalls: unknown[] = []

    try {
      await withSeedStack(
        async (stack) => {
          const jobId = await createFlowJob(stack, {
            sequence: [
              probeStep('hrc-stale-tty-reap.v1'),
              { id: 'reap', input: 'Reap stale TTYs.' },
            ],
          })

          const jobRunId = await runJob(stack, jobId)
          const payload = await getJobRun(stack, jobRunId)
          const steps = payload.jobRun.steps

          expect(payload.jobRun.status).toBe('succeeded')
          expect(steps.map((step) => [step.stepId, step.status])).toEqual([
            ['gate', 'succeeded'],
            ['reap', 'pending'],
          ])
          expect(steps[0]).toMatchObject({
            result: { kind: 'probe', name: 'hrc-stale-tty-reap.v1', outcome: 'idle' },
            branchTaken: { kind: 'outcome', key: 'idle', target: 'succeed' },
          })
          expect(inputAttemptStore.calls).toHaveLength(0)
          expect(launchCalls).toHaveLength(0)
          expect(hrcProbeCalls).toHaveLength(1)
        },
        {
          jobsStore,
          runStore,
          inputAttemptStore,
          hrcDbPath: hrc.hrcDbPath,
          runtimeResolver: createRuntimeResolver(),
          launchRoleScopedRun: createTerminalLauncher(hrc, [], launchCalls),
          hrcClient: {
            probe: async (request: unknown) => {
              hrcProbeCalls.push(request)
              return { outcome: 'idle' }
            },
          } as never,
        }
      )
    } finally {
      hrc.cleanup()
      jobsStore.close()
    }
  })

  test('scheduled probe work dispatches the agent step and records the taken branch', async () => {
    const jobsStore = createInMemoryJobsStore()
    const runStore = new InMemoryRunStore()
    const inputAttemptStore = new RecordingInputAttemptStore()
    const hrc = createHeadlessHrcDb('acp-e2e-jobflow-probe-')
    const launchCalls: LaunchCall[] = []

    try {
      await withSeedStack(
        async (stack) => {
          const jobId = await createFlowJob(stack, {
            sequence: [
              probeStep('hrc-stale-tty-reap.v1'),
              { id: 'reap', input: 'Reap stale TTYs.' },
            ],
          })

          const jobRunId = await runJob(stack, jobId)
          const payload = await getJobRun(stack, jobRunId)
          const steps = payload.jobRun.steps

          expect(payload.jobRun.status).toBe('succeeded')
          expect(steps.map((step) => [step.stepId, step.status])).toEqual([
            ['gate', 'succeeded'],
            ['reap', 'succeeded'],
          ])
          expect(steps[0]).toMatchObject({
            result: { kind: 'probe', name: 'hrc-stale-tty-reap.v1', outcome: 'work' },
            branchTaken: { kind: 'outcome', key: 'work', target: 'reap' },
          })
          expect(inputAttemptStore.calls.map((call) => call.content)).toEqual(['Reap stale TTYs.'])
          expect(launchCalls).toHaveLength(1)
        },
        {
          jobsStore,
          runStore,
          inputAttemptStore,
          hrcDbPath: hrc.hrcDbPath,
          runtimeResolver: createRuntimeResolver(),
          launchRoleScopedRun: createTerminalLauncher(
            hrc,
            [{ status: 'completed', text: 'RESULT\n{}' }],
            launchCalls
          ),
          hrcClient: {
            probe: async () => ({ outcome: 'work' }),
          } as never,
        }
      )
    } finally {
      hrc.cleanup()
      jobsStore.close()
    }
  })

  test('exec exitCode branch records the taken branch on the step run', async () => {
    const jobsStore = createInMemoryJobsStore()
    const runStore = new InMemoryRunStore()
    const inputAttemptStore = new RecordingInputAttemptStore()
    const hrc = createHeadlessHrcDb('acp-e2e-jobflow-probe-')
    const launchCalls: LaunchCall[] = []

    try {
      await withExecEnabled(async () => {
        await withSeedStack(
          async (stack) => {
            const jobId = await createFlowJob(stack, {
              sequence: [
                {
                  id: 'selector',
                  kind: 'exec',
                  exec: {
                    argv: [process.execPath, '-e', 'process.exit(7)'],
                    successExitCodes: [0, 7],
                  },
                  branches: { exitCode: { '7': 'succeed' }, default: 'fail' },
                },
              ],
            })

            const jobRunId = await runJob(stack, jobId)
            const payload = await getJobRun(stack, jobRunId)
            const [step] = payload.jobRun.steps

            expect(payload.jobRun.status).toBe('succeeded')
            expect(step).toMatchObject({
              stepId: 'selector',
              status: 'succeeded',
              result: expect.objectContaining({ kind: 'exec', exitCode: 7 }),
              branchTaken: { kind: 'exitCode', key: '7', target: 'succeed' },
            })
            expect(inputAttemptStore.calls).toHaveLength(0)
            expect(launchCalls).toHaveLength(0)
          },
          {
            jobsStore,
            runStore,
            inputAttemptStore,
            hrcDbPath: hrc.hrcDbPath,
            runtimeResolver: createRuntimeResolver(),
            launchRoleScopedRun: createTerminalLauncher(hrc, [], launchCalls),
          }
        )
      })
    } finally {
      hrc.cleanup()
      jobsStore.close()
    }
  })
})
