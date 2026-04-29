import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createInMemoryJobsStore } from 'acp-jobs-store'
import { type AcpServerDeps, InMemoryInputAttemptStore, InMemoryRunStore } from 'acp-server'

import { type SeedStack, withSeedStack } from './fixtures/seed-stack.js'

type LaunchCall = Parameters<NonNullable<AcpServerDeps['launchRoleScopedRun']>>[0]

type FlowLaunchOutcome = {
  status: 'completed' | 'failed' | 'cancelled'
  text: string
}

type HeadlessHrcFixture = {
  db: Database
  hrcDbPath: string
  cleanup(): void
}

type JobRunPayload = {
  jobRun: {
    jobRunId: string
    status: string
    errorCode?: string | undefined
    steps: Array<{
      phase: string
      stepId: string
      status: string
      attempt: number
      inputAttemptId?: string | undefined
      runId?: string | undefined
      result?: Record<string, unknown> | undefined
      resultBlock?: string | undefined
      error?: { code: string; message: string } | undefined
    }>
  }
}

class RecordingInputAttemptStore extends InMemoryInputAttemptStore {
  readonly calls: Array<Parameters<InMemoryInputAttemptStore['createAttempt']>[0]> = []

  override createAttempt(input: Parameters<InMemoryInputAttemptStore['createAttempt']>[0]) {
    this.calls.push(input)
    return super.createAttempt(input)
  }
}

function createHeadlessHrcDb(): HeadlessHrcFixture {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'acp-e2e-jobflow-exec-'))
  const hrcDbPath = join(fixtureDir, 'hrc.sqlite')
  const db = new Database(hrcDbPath)

  db.exec(`
    CREATE TABLE runs (
      run_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      error_code TEXT,
      error_message TEXT
    );
    CREATE TABLE events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT,
      event_kind TEXT NOT NULL,
      event_json TEXT NOT NULL
    );
  `)

  return {
    db,
    hrcDbPath,
    cleanup() {
      db.close()
      rmSync(fixtureDir, { recursive: true, force: true })
    },
  }
}

function insertTerminalHrcRun(
  hrc: HeadlessHrcFixture,
  hrcRunId: string,
  outcome: FlowLaunchOutcome
): void {
  hrc.db
    .prepare(
      'INSERT INTO runs (run_id, status, error_code, error_message) VALUES (?, ?, NULL, NULL)'
    )
    .run(hrcRunId, outcome.status)
  hrc.db.prepare('INSERT INTO events (run_id, event_kind, event_json) VALUES (?, ?, ?)').run(
    hrcRunId,
    'message_end',
    JSON.stringify({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: outcome.text }],
      },
    })
  )
}

function createTerminalFlowLauncher(
  hrc: HeadlessHrcFixture,
  outcomes: FlowLaunchOutcome[],
  calls: LaunchCall[]
): NonNullable<AcpServerDeps['launchRoleScopedRun']> {
  return async (input) => {
    calls.push(input)
    if (input.acpRunId === undefined) {
      throw new Error('expected flow step dispatch to provide acpRunId')
    }

    const outcome = outcomes.shift()
    if (outcome === undefined) {
      throw new Error(`no fake outcome configured for run ${input.acpRunId}`)
    }

    const hrcRunId = `hrc-${input.acpRunId}`
    insertTerminalHrcRun(hrc, hrcRunId, outcome)
    input.runStore?.updateRun(input.acpRunId, {
      status: outcome.status,
      hrcRunId,
      hostSessionId: 'session-jobflow-exec-e2e',
    })

    return {
      runId: hrcRunId,
      sessionId: 'session-jobflow-exec-e2e',
    }
  }
}

async function createFlowJob(stack: SeedStack, flow: Record<string, unknown>): Promise<string> {
  const response = await stack.cli.request({
    method: 'POST',
    path: '/v1/admin/jobs',
    body: {
      agentId: 'larry',
      projectId: stack.seed.projectId,
      scopeRef: `agent:larry:project:${stack.seed.projectId}:task:T-01321:role:implementer`,
      laneRef: 'main',
      schedule: { cron: '*/5 * * * *' },
      input: { content: 'run the jobflow exec acceptance test' },
      flow,
    },
  })
  const payload = (await response.json()) as { job: { jobId: string } }

  expect(response.status).toBe(201)
  return payload.job.jobId
}

async function runJob(stack: SeedStack, jobId: string): Promise<string> {
  const response = await stack.cli.request({
    method: 'POST',
    path: `/v1/admin/jobs/${jobId}/run`,
  })
  const payload = (await response.json()) as { jobRun: { jobRunId: string } }

  expect(response.status).toBe(202)
  return payload.jobRun.jobRunId
}

async function getJobRun(stack: SeedStack, jobRunId: string): Promise<JobRunPayload> {
  const response = await stack.cli.request({
    method: 'GET',
    path: `/v1/job-runs/${jobRunId}`,
  })
  const payload = (await response.json()) as JobRunPayload

  expect(response.status).toBe(200)
  return payload
}

function createRuntimeResolver(cwd: string): NonNullable<AcpServerDeps['runtimeResolver']> {
  return async (sessionRef) => ({
    agentRoot: `/tmp/${sessionRef.scopeRef.replace(/[^a-zA-Z0-9_-]+/g, '-')}`,
    projectRoot: cwd,
    cwd,
    runMode: 'task',
    bundle: { kind: 'agent-default' },
    harness: { provider: 'openai', interactive: true, model: 'gpt-5-codex' },
  })
}

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
