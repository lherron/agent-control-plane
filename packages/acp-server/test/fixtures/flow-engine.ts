import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInMemoryAdminStore } from 'acp-admin-store'
import type { ExecStepResult, JobFlow, JobFlowStep } from 'acp-core'
import {
  type JobRunStatus,
  type JobRunTrigger,
  type NativeStepExecutorDeps,
  createInMemoryJobsStore,
} from 'acp-jobs-store'
import {
  type AcpServerDeps,
  InMemoryInputAttemptStore,
  type LaunchRoleScopedRun,
} from '../../src/index.js'
import { advanceJobFlow } from '../../src/jobs/flow-engine.js'
import { withWiredServer } from './wired-server.js'

type LaunchCall = Parameters<LaunchRoleScopedRun>[0]
export type JobsStore = ReturnType<typeof createInMemoryJobsStore>
type HarnessFixture = Parameters<Parameters<typeof withWiredServer>[0]>[0]
export type FlowEngineDeps = HarnessFixture &
  Pick<
    AcpServerDeps,
    | 'jobsStore'
    | 'inputAttemptStore'
    | 'jobExecPolicy'
    | 'runtimeResolver'
    | 'launchRoleScopedRun'
    | 'hrcClient'
    | 'adminStore'
  > & { hrcDbPath: string; nativeStepExecutor?: Omit<NativeStepExecutorDeps, 'store'> }

type FlowLaunchOutcome = {
  status: 'completed' | 'failed' | 'cancelled' | 'running'
  text?: string | undefined
}

type HeadlessHrcFixture = {
  db: Database
  hrcDbPath: string
  cleanup(): void
}

export const FLOW_JOB_SCOPE_REF = 'agent:larry:project:demo-project:task:T-01319:role:implementer'

class RecordingInputAttemptStore extends InMemoryInputAttemptStore {
  readonly calls: Array<Parameters<InMemoryInputAttemptStore['createAttempt']>[0]> = []

  override createAttempt(input: Parameters<InMemoryInputAttemptStore['createAttempt']>[0]) {
    this.calls.push(input)
    return super.createAttempt(input)
  }
}

function createHeadlessHrcDb(): HeadlessHrcFixture {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'acp-flow-engine-'))
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
    CREATE TABLE hrc_events (
      hrc_seq INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT,
      event_kind TEXT NOT NULL,
      payload_json TEXT NOT NULL
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

function insertHrcRun(hrc: HeadlessHrcFixture, hrcRunId: string, outcome: FlowLaunchOutcome): void {
  hrc.db.run(
    'INSERT INTO runs (run_id, status, error_code, error_message) VALUES (?, ?, NULL, NULL)',
    hrcRunId,
    outcome.status
  )

  if (outcome.text !== undefined) {
    hrc.db.run(
      'INSERT INTO events (run_id, event_kind, event_json) VALUES (?, ?, ?)',
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
    hrc.db.run(
      'INSERT INTO hrc_events (run_id, event_kind, payload_json) VALUES (?, ?, ?)',
      hrcRunId,
      'turn.completed',
      JSON.stringify({ finalOutput: outcome.text })
    )
  }
}

function createFlowLauncher(
  hrc: HeadlessHrcFixture,
  outcomes: FlowLaunchOutcome[],
  calls: LaunchCall[] = [],
  order: string[] = []
): LaunchRoleScopedRun {
  return async (input) => {
    calls.push(input)
    order.push('dispatch')

    const acpRunId = input.acpRunId
    if (acpRunId === undefined) {
      throw new Error('expected flow step dispatch to provide acpRunId')
    }

    const outcome = outcomes.shift() ?? { status: 'completed', text: 'RESULT\n{}' }
    const hrcRunId = `hrc-${acpRunId}`
    if (outcome.status === 'running') {
      input.runStore?.updateRun(acpRunId, {
        status: 'running',
        hrcRunId,
        hostSessionId: 'hsid-flow-engine',
        runtimeId: `rt-${acpRunId}`,
      })
    } else {
      insertHrcRun(hrc, hrcRunId, outcome)
      input.runStore?.updateRun(acpRunId, {
        status: outcome.status,
        hrcRunId,
        hostSessionId: 'hsid-flow-engine',
        runtimeId: `rt-${acpRunId}`,
      })
    }

    return { runId: hrcRunId, sessionId: 'hsid-flow-engine' }
  }
}

export function execResult(overrides: Partial<ExecStepResult>): ExecStepResult {
  return {
    kind: 'exec',
    argv: [process.execPath, '-e', 'process.exit(0)'],
    cwd: process.cwd(),
    exitCode: 0,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    durationMs: 0,
    startedAt: '2026-04-28T12:00:00.000Z',
    completedAt: '2026-04-28T12:00:00.000Z',
    ...overrides,
  }
}

export function agentStep(id: string, input = `run ${id}`): JobFlowStep {
  return { id, input }
}

export function execStep(
  id: string,
  code: string,
  extra: Partial<Extract<JobFlowStep, { kind: 'exec' }>> = {}
): JobFlowStep {
  return {
    id,
    kind: 'exec',
    exec: {
      argv: [process.execPath, '-e', code],
    },
    ...extra,
  }
}
export function createFlowJob(store: JobsStore, flow: JobFlow) {
  return store.createJob({
    agentId: 'larry',
    projectId: 'demo-project',
    scopeRef: FLOW_JOB_SCOPE_REF,
    laneRef: 'main',
    schedule: { cron: '*/5 * * * *' },
    input: { content: 'legacy input must not dispatch for flow jobs' },
    flow,
    disabled: false,
    createdAt: '2026-04-28T12:00:00.000Z',
  }).job
}

export function createJobRun(
  store: JobsStore,
  jobId: string,
  options: {
    jobRunId?: string | undefined
    triggeredAt?: string | undefined
    triggeredBy?: JobRunTrigger | undefined
    status?: JobRunStatus | undefined
    completedAt?: string | undefined
  } = {}
) {
  return store.appendJobRun({
    jobId,
    jobRunId: options.jobRunId ?? `jrun_${jobId}`,
    triggeredAt: options.triggeredAt ?? '2026-04-28T12:00:00.000Z',
    triggeredBy: options.triggeredBy ?? 'manual',
    status: options.status ?? 'claimed',
    completedAt: options.completedAt,
  }).jobRun
}
export async function withFlowHarness<T>(
  run: (input: {
    fixture: HarnessFixture
    deps: FlowEngineDeps
    jobsStore: JobsStore
    hrc: HeadlessHrcFixture
    inputAttemptStore: RecordingInputAttemptStore
    launchCalls: LaunchCall[]
    order: string[]
  }) => Promise<T> | T,
  outcomes: FlowLaunchOutcome[] = []
): Promise<T> {
  const jobsStore = createInMemoryJobsStore()
  const hrc = createHeadlessHrcDb()
  const inputAttemptStore = new RecordingInputAttemptStore()
  const launchCalls: LaunchCall[] = []
  const order: string[] = []
  const adminStore = createInMemoryAdminStore()
  const launchRoleScopedRun = createFlowLauncher(hrc, outcomes, launchCalls, order)
  const runtimeResolver: NonNullable<AcpServerDeps['runtimeResolver']> = async () => ({
    agentRoot: '/tmp/agents/larry',
    projectRoot: process.cwd(),
    cwd: process.cwd(),
    runMode: 'task',
    bundle: { kind: 'compose', compose: [] },
    harness: { provider: 'openai', interactive: true },
  })
  const jobExecPolicy: NonNullable<AcpServerDeps['jobExecPolicy']> = {
    enabled: true,
    allowedCwdRoots: [process.cwd()],
    defaultTimeoutMs: 5_000,
    maxTimeoutMs: 5_000,
    defaultMaxOutputBytes: 64 * 1024,
    maxOutputBytes: 64 * 1024,
    inheritEnvAllowlist: [],
  }

  try {
    return await withWiredServer(
      async (fixture) => {
        const deps: FlowEngineDeps = {
          ...fixture,
          jobsStore,
          inputAttemptStore,
          adminStore,
          hrcDbPath: hrc.hrcDbPath,
          jobExecPolicy,
          runtimeResolver,
          launchRoleScopedRun,
        }

        return await run({
          fixture,
          deps,
          jobsStore,
          hrc,
          inputAttemptStore,
          launchCalls,
          order,
        })
      },
      {
        jobsStore,
        inputAttemptStore,
        adminStore,
        hrcDbPath: hrc.hrcDbPath,
        jobExecPolicy,
        runtimeResolver,
        launchRoleScopedRun,
      }
    )
  } finally {
    adminStore.close()
    hrc.cleanup()
    jobsStore.close()
  }
}

export async function advanceCreatedFlow(input: {
  deps: FlowEngineDeps
  jobsStore: JobsStore
  flow: JobFlow
}) {
  const job = createFlowJob(input.jobsStore, input.flow)
  const jobRun = createJobRun(input.jobsStore, job.jobId)

  const advanced = await advanceJobFlow({
    deps: input.deps as never,
    job,
    jobRun,
    actor: { kind: 'system', id: 'flow-engine-test' },
    now: '2026-04-28T12:01:00.000Z',
  })

  return { job, jobRun, advanced }
}
