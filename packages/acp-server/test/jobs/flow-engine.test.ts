import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createInMemoryAdminStore } from 'acp-admin-store'
import type { ExecStepResult, JobFlow, JobFlowStep, Run } from 'acp-core'
import type { JobRunStatus, JobRunTrigger, NativeStepExecutorDeps } from 'acp-jobs-store'
import { createInMemoryJobsStore } from 'acp-jobs-store'

import {
  type AcpServerDeps,
  InMemoryInputAttemptStore,
  type LaunchRoleScopedRun,
} from '../../src/index.js'
import { advanceJobFlow } from '../../src/jobs/flow-engine.js'

import { withWiredServer } from '../fixtures/wired-server.js'

type LaunchCall = Parameters<LaunchRoleScopedRun>[0]
type JobsStore = ReturnType<typeof createInMemoryJobsStore>
type HarnessFixture = Parameters<Parameters<typeof withWiredServer>[0]>[0]
type FlowEngineDeps = HarnessFixture &
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

const FLOW_JOB_SCOPE_REF = 'agent:larry:project:demo-project:task:T-01319:role:implementer'

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

function execResult(overrides: Partial<ExecStepResult>): ExecStepResult {
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

function agentStep(id: string, input = `run ${id}`): JobFlowStep {
  return { id, input }
}

function execStep(
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

function createFlowJob(store: JobsStore, flow: JobFlow) {
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

function createJobRun(
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

function seedPriorStepRun(input: {
  deps: FlowEngineDeps
  jobsStore: JobsStore
  job: ReturnType<typeof createFlowJob>
  jobRunId: string
  stepId: string
  triggeredAt: string
  triggeredBy?: JobRunTrigger | undefined
  phase?: 'sequence' | 'onFailure' | undefined
  stepStatus?: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'cancelled'
  jobRunStatus?: JobRunStatus | undefined
  runtimeId?: string | undefined
  runId?: string | undefined
  runStatus?: Run['status'] | undefined
  runMetadata?: Readonly<Record<string, unknown>> | undefined
  createRunRecord?: boolean | undefined
}) {
  let runId = input.runId
  if (input.createRunRecord !== false) {
    const run = input.deps.runStore.createRun({
      sessionRef: { scopeRef: input.job.scopeRef, laneRef: input.job.laneRef },
      status: input.runStatus ?? 'completed',
      ...(input.runMetadata !== undefined ? { metadata: input.runMetadata } : {}),
    })
    runId = run.runId
    input.deps.runStore.updateRun(run.runId, {
      status: input.runStatus ?? 'completed',
      hrcRunId: `hrc-${run.runId}`,
      hostSessionId: `hsid-${input.runtimeId ?? run.runId}`,
      ...(input.runtimeId !== undefined ? { runtimeId: input.runtimeId } : {}),
    })
  }

  const jobRun = createJobRun(input.jobsStore, input.job.jobId, {
    jobRunId: input.jobRunId,
    triggeredAt: input.triggeredAt,
    triggeredBy: input.triggeredBy ?? 'schedule',
    status: input.jobRunStatus ?? 'succeeded',
    completedAt: '2026-04-28T12:10:00.000Z',
  })
  input.jobsStore.jobStepRuns.insertMany(jobRun.jobRunId, input.phase ?? 'sequence', [
    {
      stepId: input.stepId,
      status: input.stepStatus ?? 'succeeded',
      attempt: 1,
      ...(runId !== undefined ? { runId } : {}),
      startedAt: '2026-04-28T12:00:00.000Z',
      completedAt:
        input.stepStatus === 'pending' || input.stepStatus === 'running'
          ? undefined
          : '2026-04-28T12:05:00.000Z',
    },
  ])

  return { jobRun, runId }
}

function hrcClientForFreshStep(input: {
  order: string[]
  terminate?: ((runtimeId: string, options: unknown) => Promise<void> | void) | undefined
  terminateCalls?: Array<{ runtimeId: string; options: unknown }> | undefined
  failIfRotated?: boolean | undefined
}) {
  return {
    terminate: async (runtimeId: string, options: unknown) => {
      input.order.push(`terminate:${runtimeId}`)
      input.terminateCalls?.push({ runtimeId, options })
      await input.terminate?.(runtimeId, options)
      return { ok: true, runtimeId, hostSessionId: 'hsid-terminated', droppedContinuation: false }
    },
    resolveSession: async (request: unknown) => {
      if (input.failIfRotated === true) {
        throw new Error('fresh context rotation should not run')
      }
      input.order.push('resolveSession')
      return { found: true, hostSessionId: 'hsid-fresh', request }
    },
    clearContext: async (request: unknown) => {
      if (input.failIfRotated === true) {
        throw new Error('fresh context rotation should not run')
      }
      input.order.push('clearContext')
      return {
        hostSessionId: 'hsid-fresh',
        generation: 2,
        priorHostSessionId: 'hsid-previous',
        request,
      }
    },
  } as never
}

function scheduledFreshRunMetadata(input: {
  job: ReturnType<typeof createFlowJob>
  stepId?: string | undefined
  phase?: 'sequence' | 'onFailure' | undefined
  freshDuration?: string | undefined
  windowStartedAt: string
}): Readonly<Record<string, unknown>> {
  return {
    scheduledFresh: {
      jobId: input.job.jobId,
      phase: input.phase ?? 'sequence',
      stepId: input.stepId ?? 'fresh-start',
      freshDuration: input.freshDuration ?? 'PT24H',
      windowStartedAt: input.windowStartedAt,
    },
  }
}

async function advanceScheduledFreshRunWithPriorRuntime(input: {
  deps: FlowEngineDeps
  jobsStore: JobsStore
  order: string[]
  terminate: (runtimeId: string, options: unknown) => Promise<void> | void
  priorRuntimeId?: string | undefined
  currentJobRunId?: string | undefined
}) {
  const job = createFlowJob(input.jobsStore, {
    sequence: [{ id: 'fresh-start', input: 'start with fresh context', fresh: true }],
  })
  const priorRuntimeId = input.priorRuntimeId ?? 'rt-prior'
  seedPriorStepRun({
    deps: input.deps,
    jobsStore: input.jobsStore,
    job,
    jobRunId: `jrun_prior_${priorRuntimeId.replaceAll('-', '_')}`,
    stepId: 'fresh-start',
    triggeredAt: '2026-04-28T12:00:00.000Z',
    runtimeId: priorRuntimeId,
  })
  const jobRun = createJobRun(input.jobsStore, job.jobId, {
    jobRunId: input.currentJobRunId ?? `jrun_current_${priorRuntimeId.replaceAll('-', '_')}`,
    triggeredAt: '2026-04-28T12:20:00.000Z',
    triggeredBy: 'schedule',
    status: 'claimed',
  })

  const advanced = await advanceJobFlow({
    deps: {
      ...input.deps,
      hrcClient: hrcClientForFreshStep({
        order: input.order,
        terminate: input.terminate,
      }),
    } as never,
    job,
    jobRun,
    actor: { kind: 'system', id: 'flow-engine-test' },
    now: '2026-04-28T12:21:00.000Z',
  })

  const stepRun = input.jobsStore.jobStepRuns.getById(
    jobRun.jobRunId,
    'sequence',
    'fresh-start',
    1
  ).jobStepRun
  if (stepRun === undefined) {
    throw new Error('expected current fresh step run')
  }

  return { job, jobRun, advanced, stepRun, priorRuntimeId }
}

function expectFreshCleanupDegraded(input: {
  advanced: { status: JobRunStatus; errorCode?: string | undefined }
  stepRun: NonNullable<ReturnType<JobsStore['jobStepRuns']['getById']>['jobStepRun']>
  order: string[]
  runtimeId: string
  expectedFailureCode: string
}) {
  // T-05415: cleanup failures are health degradations, not scheduled-run failures.
  expect(input.advanced).toMatchObject({ status: 'succeeded' })
  expect(input.advanced).not.toMatchObject({ errorCode: 'pre_run_cleanup_failed' })
  expect(input.order).toEqual([
    `terminate:${input.runtimeId}`,
    'resolveSession',
    'clearContext',
    'dispatch',
  ])
  expect(input.stepRun).toMatchObject({
    status: 'succeeded',
    error: undefined,
    degradation: {
      code: 'scheduled_fresh_pre_run_cleanup_degraded',
      previousRuntimeId: input.runtimeId,
      failureCode: input.expectedFailureCode,
    },
  })
}

async function withFlowHarness<T>(
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

async function advanceCreatedFlow(input: {
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

describe('advanceJobFlow validation backstop', () => {
  test('runtime backstop includes shared flow validation path/code in the thrown message', async () => {
    await withFlowHarness(async ({ deps, jobsStore }) => {
      const job = createFlowJob(jobsStore, {
        sequence: [
          {
            id: 'build',
            kind: 'exec',
            exec: { argv: ['bun', 'run', 'build'] },
            branches: { default: 'missing-step' },
          },
        ],
      })
      const jobRun = createJobRun(jobsStore, job.jobId)

      // T-05418: runtime remains a backstop, but it must not discard the
      // functional validator errors when an invalid flow somehow reaches fire time.
      let thrown: unknown
      try {
        await advanceJobFlow({
          deps: deps as never,
          job,
          jobRun,
          actor: { kind: 'system', id: 'flow-engine-test' },
          now: '2026-04-28T12:01:00.000Z',
        })
      } catch (error) {
        thrown = error
      }

      expect(thrown).toBeInstanceOf(Error)
      const message = thrown instanceof Error ? thrown.message : String(thrown)
      expect(message).toContain('invalid_flow_next')
      expect(message).toContain('flow.sequence[0].branches.default')
    })
  })
})

describe('advanceJobFlow exec steps', () => {
  test('T-05421 exec cwd policy implicitly allows the scope-resolved placement root', async () => {
    await withFlowHarness(async ({ deps, jobsStore }) => {
      const placementRoot = mkdtempSync(join(tmpdir(), 'acp-flow-placement-'))

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
              execStep('pwd', "process.stdout.write(process.cwd())"),
              agentStep('report', 'report after scoped exec success'),
            ],
          },
        })

        const stepRun = jobsStore.jobStepRuns.getById(jobRun.jobRunId, 'sequence', 'pwd', 1)
          .jobStepRun
        expect(stepRun).toMatchObject({
          status: 'succeeded',
          result: expect.objectContaining({
            kind: 'exec',
            cwd: placementRoot,
            stdout: placementRoot,
          }),
        })
        expect(advanced.status).toBe('succeeded')
        expect(job.scopeRef).toBe(FLOW_JOB_SCOPE_REF)
      } finally {
        rmSync(placementRoot, { recursive: true, force: true })
      }
    })
  })

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
          return { inputAttemptId: 'iat_native_001', runId: 'run_native_001' }
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

  test('agent step with fresh true still clears continuation before dispatch', async () => {
    await withFlowHarness(
      async ({ deps, jobsStore, order }) => {
        const hrcCalls: Array<{ method: string; request: unknown }> = []
        const { advanced } = await advanceCreatedFlow({
          deps: {
            ...deps,
            hrcClient: {
              resolveSession: async (request: unknown) => {
                order.push('resolveSession')
                hrcCalls.push({ method: 'resolveSession', request })
                return { found: true, hostSessionId: 'hsid-fresh' }
              },
              clearContext: async (request: unknown) => {
                order.push('clearContext')
                hrcCalls.push({ method: 'clearContext', request })
                return {
                  hostSessionId: 'hsid-fresh',
                  generation: 2,
                  priorHostSessionId: 'hsid-previous',
                }
              },
            } as never,
          } as never,
          jobsStore,
          flow: {
            sequence: [{ id: 'fresh-start', input: 'start with fresh context', fresh: true }],
          },
        })

        expect(advanced.status).toBe('succeeded')
        expect(order).toEqual(['resolveSession', 'clearContext', 'dispatch'])
        expect(hrcCalls).toEqual([
          {
            method: 'resolveSession',
            request: {
              sessionRef:
                'agent:larry:project:demo-project:task:T-01319:role:implementer/lane:main',
            },
          },
          {
            method: 'clearContext',
            request: { hostSessionId: 'hsid-fresh', dropContinuation: true },
          },
        ])
      },
      [{ status: 'completed' }]
    )
  })
})

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
        dispatchAgentInput: async () => ({ inputAttemptId: 'iat_native', runId: 'run_native' }),
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

  test('hung agent step timeout fails the step and returns without waiting for HRC termination', async () => {
    await withFlowHarness(async ({ deps, jobsStore }) => {
      const job = createFlowJob(jobsStore, {
        sequence: [{ id: 'hung-agent', input: 'never respond', timeout: 'PT1M' }],
      })
      const currentRun = deps.runStore.createRun({
        sessionRef: { scopeRef: job.scopeRef, laneRef: job.laneRef },
        status: 'running',
      })
      deps.runStore.updateRun(currentRun.runId, {
        status: 'running',
        runtimeId: 'rt-hung-agent',
        hrcRunId: `hrc-${currentRun.runId}`,
      })
      const jobRun = createJobRun(jobsStore, job.jobId, {
        jobRunId: 'jrun_hung_agent_timeout',
        triggeredAt: '2026-04-28T12:00:00.000Z',
        triggeredBy: 'schedule',
        status: 'dispatched',
      })
      jobsStore.jobStepRuns.insertMany(jobRun.jobRunId, 'sequence', [
        {
          stepId: 'hung-agent',
          status: 'running',
          attempt: 1,
          runId: currentRun.runId,
          startedAt: '2026-04-28T12:00:00.000Z',
        },
      ])

      const terminateCalls: Array<{ runtimeId: string; options: unknown }> = []
      const advanced = await Promise.race([
        advanceJobFlow({
          deps: {
            ...deps,
            hrcClient: {
              terminate: (runtimeId: string, options: unknown) => {
                terminateCalls.push({ runtimeId, options })
                return new Promise(() => {
                  // Intentionally unresolved: the reaper/timeout path must write
                  // terminal store state before bounded best-effort termination.
                })
              },
            },
          } as never,
          job,
          jobRun,
          actor: { kind: 'system', id: 'flow-engine-test' },
          now: '2026-04-28T12:02:00.000Z',
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('advanceJobFlow waited on HRC termination')), 150)
        ),
      ])

      expect(terminateCalls).toHaveLength(1)
      expect(terminateCalls[0]?.runtimeId).toBe('rt-hung-agent')
      expect(advanced).toMatchObject({
        status: 'failed',
        errorCode: 'agent_step_timeout',
        completedAt: '2026-04-28T12:02:00.000Z',
      })
      expect(
        jobsStore.jobStepRuns.getById(jobRun.jobRunId, 'sequence', 'hung-agent', 1).jobStepRun
      ).toMatchObject({
        status: 'failed',
        error: { code: 'agent_step_timeout' },
        completedAt: '2026-04-28T12:02:00.000Z',
      })
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

  test('benign unknown-runtime termination still dispatches', async () => {
    await withFlowHarness(
      async ({ deps, jobsStore, order }) => {
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
        const jobRun = createJobRun(jobsStore, job.jobId, {
          jobRunId: 'jrun_current',
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
                throw Object.assign(new Error('unknown runtime "rt-prior"'), {
                  code: 'unknown_runtime',
                })
              },
            }),
          } as never,
          job,
          jobRun,
          actor: { kind: 'system', id: 'flow-engine-test' },
          now: '2026-04-28T12:21:00.000Z',
        })

        expect(advanced.status).toBe('succeeded')
        expect(order).toEqual(['terminate:rt-prior', 'resolveSession', 'clearContext', 'dispatch'])
      },
      [{ status: 'completed' }]
    )
  })

  test('already-terminated runtime termination still dispatches', async () => {
    await withFlowHarness(
      async ({ deps, jobsStore, order }) => {
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
        const jobRun = createJobRun(jobsStore, job.jobId, {
          jobRunId: 'jrun_current',
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
                throw Object.assign(new Error('runtime "rt-prior" is terminated'), {
                  code: 'runtime_unavailable',
                })
              },
            }),
          } as never,
          job,
          jobRun,
          actor: { kind: 'system', id: 'flow-engine-test' },
          now: '2026-04-28T12:21:00.000Z',
        })

        expect(advanced.status).toBe('succeeded')
        expect(order).toEqual(['terminate:rt-prior', 'resolveSession', 'clearContext', 'dispatch'])
      },
      [{ status: 'completed' }]
    )
  })

  test('T-05415: repeated terminate timeouts degrade and still rotate the scheduled fresh run', async () => {
    await withFlowHarness(
      async ({ deps, jobsStore, order }) => {
        const job = createFlowJob(jobsStore, {
          sequence: [{ id: 'fresh-start', input: 'start with fresh context', fresh: true }],
        })
        seedPriorStepRun({
          deps,
          jobsStore,
          job,
          jobRunId: 'jrun_prior_timeout_runtime',
          stepId: 'fresh-start',
          triggeredAt: '2026-04-28T12:00:00.000Z',
          runtimeId: 'rt-poison-timeout',
        })

        let lastAdvanced: { status: JobRunStatus; errorCode?: string | undefined } | undefined
        let lastStepRun:
          | NonNullable<ReturnType<JobsStore['jobStepRuns']['getById']>['jobStepRun']>
          | undefined
        for (const attempt of [1, 2, 3]) {
          order.length = 0
          const jobRun = createJobRun(jobsStore, job.jobId, {
            jobRunId: `jrun_current_timeout_${attempt}`,
            triggeredAt: `2026-04-28T12:${20 + attempt}:00.000Z`,
            triggeredBy: 'schedule',
            status: 'claimed',
          })

          lastAdvanced = await advanceJobFlow({
            deps: {
              ...deps,
              hrcClient: hrcClientForFreshStep({
                order,
                terminate: () => {
                  throw Object.assign(new Error('terminate timed out after 50ms'), {
                    code: 'terminate_timeout',
                  })
                },
              }),
            } as never,
            job,
            jobRun,
            actor: { kind: 'system', id: 'flow-engine-test' },
            now: `2026-04-28T12:${21 + attempt}:00.000Z`,
          })
          lastStepRun = jobsStore.jobStepRuns.getById(
            jobRun.jobRunId,
            'sequence',
            'fresh-start',
            1
          ).jobStepRun
        }

        expectFreshCleanupDegraded({
          advanced: lastAdvanced ?? { status: 'failed' },
          stepRun:
            lastStepRun ??
            (() => {
              throw new Error('expected final step run')
            })(),
          order,
          runtimeId: 'rt-poison-timeout',
          expectedFailureCode: 'terminate_timeout',
        })
      },
      [{ status: 'completed' }]
    )
  })

  test('T-05415: terminate 500 emits a health event and does not finalize the run with pre_run_cleanup_failed', async () => {
    await withFlowHarness(
      async ({ deps, jobsStore, order }) => {
        const { advanced, stepRun, priorRuntimeId } =
          await advanceScheduledFreshRunWithPriorRuntime({
            deps,
            jobsStore,
            order,
            priorRuntimeId: 'rt-poison-500',
            currentJobRunId: 'jrun_current_cleanup_500',
            terminate: () => {
              throw Object.assign(new Error('HRC terminate returned 500'), {
                code: 'http_500',
                status: 500,
              })
            },
          })

        expectFreshCleanupDegraded({
          advanced,
          stepRun,
          order,
          runtimeId: priorRuntimeId,
          expectedFailureCode: 'http_500',
        })
        expect(advanced).not.toMatchObject({
          status: 'failed',
          errorCode: 'pre_run_cleanup_failed',
        })
        const healthEvents = jobsStore.claimPendingInboxEvents({
          leaseOwner: 'flow-engine-test',
          leaseExpiresAt: '2026-04-28T12:22:00.000Z',
          now: '2026-04-28T12:21:30.000Z',
          limit: 10,
        })
        expect(healthEvents).toHaveLength(1)
        expect(healthEvents[0]).toMatchObject({
          source: 'acp-health',
          event: 'scheduled_fresh_pre_run_cleanup_degraded',
          payload: {
            event: 'scheduled_fresh_pre_run_cleanup_degraded',
            payload: {
              jobRunId: 'jrun_current_cleanup_500',
              stepId: 'fresh-start',
              previousRuntimeId: priorRuntimeId,
              failureCode: 'http_500',
            },
          },
        })
      },
      [{ status: 'completed' }]
    )
  })

  test('T-05415: already gone runtime remains a clean success without degradation', async () => {
    await withFlowHarness(
      async ({ deps, jobsStore, order }) => {
        const { advanced, stepRun, priorRuntimeId } =
          await advanceScheduledFreshRunWithPriorRuntime({
            deps,
            jobsStore,
            order,
            priorRuntimeId: 'rt-already-gone',
            currentJobRunId: 'jrun_current_already_gone',
            terminate: () => {
              throw Object.assign(new Error('unknown runtime "rt-already-gone"'), {
                code: 'unknown_runtime',
              })
            },
          })

        expect(advanced.status).toBe('succeeded')
        expect(order).toEqual([
          `terminate:${priorRuntimeId}`,
          'resolveSession',
          'clearContext',
          'dispatch',
        ])
        expect(stepRun.status).toBe('succeeded')
        expect(stepRun.error).toBeUndefined()
        expect(stepRun).not.toMatchObject({
          degradation: expect.objectContaining({
            code: 'scheduled_fresh_pre_run_cleanup_degraded',
          }),
        })
        expect(
          jobsStore.claimPendingInboxEvents({
            leaseOwner: 'flow-engine-test',
            leaseExpiresAt: '2026-04-28T12:22:00.000Z',
            now: '2026-04-28T12:21:30.000Z',
            limit: 10,
          })
        ).toHaveLength(0)
      },
      [{ status: 'completed' }]
    )
  })

  test('T-05415: reaped still-running predecessor is treated as terminal so the next scheduled fresh run proceeds', async () => {
    await withFlowHarness(
      async ({ deps, jobsStore, order }) => {
        const job = createFlowJob(jobsStore, {
          sequence: [
            {
              id: 'fresh-start',
              input: 'must not wedge after predecessor reaper terminalizes the run',
              fresh: true,
              freshDuration: 'PT24H',
            },
          ],
        })
        seedPriorStepRun({
          deps,
          jobsStore,
          job,
          jobRunId: 'jrun_prior_reaped_running',
          stepId: 'fresh-start',
          triggeredAt: '2026-04-28T12:00:00.000Z',
          stepStatus: 'running',
          jobRunStatus: 'failed',
          runStatus: 'running',
          runtimeId: 'rt-prior-reaped-running',
          runMetadata: scheduledFreshRunMetadata({
            job,
            windowStartedAt: '2026-04-28T12:00:00.000Z',
          }),
        })
        const jobRun = createJobRun(jobsStore, job.jobId, {
          jobRunId: 'jrun_current_after_reaper',
          triggeredAt: '2026-04-29T12:20:00.000Z',
          triggeredBy: 'schedule',
          status: 'claimed',
        })

        const advanced = await advanceJobFlow({
          deps: {
            ...deps,
            hrcClient: hrcClientForFreshStep({ order }),
          } as never,
          job,
          jobRun,
          actor: { kind: 'system', id: 'flow-engine-test' },
          now: '2026-04-29T12:21:00.000Z',
        })

        expect(advanced.status).toBe('succeeded')
        expect(advanced).not.toMatchObject({ errorCode: 'pre_run_cleanup_failed' })
        expect(order).toEqual([
          'terminate:rt-prior-reaped-running',
          'resolveSession',
          'clearContext',
          'dispatch',
        ])
        expect(
          jobsStore.jobStepRuns.getById(jobRun.jobRunId, 'sequence', 'fresh-start', 1).jobStepRun
        ).toMatchObject({ status: 'succeeded', error: undefined })
      },
      [{ status: 'completed' }]
    )
  })

  test('unknown termination errors fail closed and do not dispatch', async () => {
    await withFlowHarness(async ({ deps, jobsStore, inputAttemptStore, launchCalls, order }) => {
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
      const jobRun = createJobRun(jobsStore, job.jobId, {
        jobRunId: 'jrun_current',
        triggeredAt: '2026-04-28T12:20:00.000Z',
        triggeredBy: 'schedule',
        status: 'claimed',
      })

      const advanced = await advanceJobFlow({
        deps: {
          ...deps,
          hrcClient: hrcClientForFreshStep({
            order,
            failIfRotated: true,
            terminate: () => {
              throw Object.assign(new Error('socket hung up'), {
                code: 'transport_unavailable',
              })
            },
          }),
        } as never,
        job,
        jobRun,
        actor: { kind: 'system', id: 'flow-engine-test' },
        now: '2026-04-28T12:21:00.000Z',
      })

      expect(advanced.status).toBe('failed')
      expect(inputAttemptStore.calls).toHaveLength(0)
      expect(launchCalls).toHaveLength(0)
      expect(order).toEqual(['terminate:rt-prior'])
      expect(
        jobsStore.jobStepRuns.getById(jobRun.jobRunId, 'sequence', 'fresh-start', 1).jobStepRun
      ).toMatchObject({
        status: 'failed',
        error: {
          code: 'pre_run_cleanup_failed',
          message: 'failed to clean previous fresh step runtime rt-prior: socket hung up',
        },
      })
    })
  })
})

describe('advanceJobFlow scheduled freshDuration windows', () => {
  test('first scheduled run rotates context and records window metadata', async () => {
    await withFlowHarness(
      async ({ deps, jobsStore, order }) => {
        const job = createFlowJob(jobsStore, {
          sequence: [
            {
              id: 'fresh-start',
              input: 'start with fresh context',
              fresh: true,
              freshDuration: 'PT24H',
            },
          ],
        })
        const jobRun = createJobRun(jobsStore, job.jobId, {
          jobRunId: 'jrun_first_duration',
          triggeredAt: '2026-04-28T12:00:00.000Z',
          triggeredBy: 'schedule',
          status: 'claimed',
        })

        const advanced = await advanceJobFlow({
          deps: {
            ...deps,
            hrcClient: hrcClientForFreshStep({ order }),
          } as never,
          job,
          jobRun,
          actor: { kind: 'system', id: 'flow-engine-test' },
          now: '2026-04-28T12:01:00.000Z',
        })

        expect(advanced.status).toBe('succeeded')
        expect(order).toEqual(['resolveSession', 'clearContext', 'dispatch'])
        const stepRun = jobsStore.jobStepRuns.getById(
          jobRun.jobRunId,
          'sequence',
          'fresh-start',
          1
        ).jobStepRun
        const run = deps.runStore.getRun(stepRun?.runId ?? '')
        expect(run?.metadata?.['scheduledFresh']).toEqual({
          jobId: job.jobId,
          phase: 'sequence',
          stepId: 'fresh-start',
          freshDuration: 'PT24H',
          windowStartedAt: '2026-04-28T12:01:00.000Z',
        })
      },
      [{ status: 'completed' }]
    )
  })

  test('inside freshDuration dispatches without terminate or clear and propagates the window', async () => {
    await withFlowHarness(
      async ({ deps, jobsStore, order }) => {
        const job = createFlowJob(jobsStore, {
          sequence: [
            {
              id: 'fresh-start',
              input: 'continue inside retained session',
              fresh: true,
              freshDuration: 'PT24H',
            },
          ],
        })
        seedPriorStepRun({
          deps,
          jobsStore,
          job,
          jobRunId: 'jrun_prior_duration',
          stepId: 'fresh-start',
          triggeredAt: '2026-04-28T12:00:00.000Z',
          runtimeId: 'rt-prior-duration',
          runMetadata: scheduledFreshRunMetadata({
            job,
            windowStartedAt: '2026-04-28T12:00:00.000Z',
          }),
        })
        const jobRun = createJobRun(jobsStore, job.jobId, {
          jobRunId: 'jrun_inside_duration',
          triggeredAt: '2026-04-28T12:20:00.000Z',
          triggeredBy: 'schedule',
          status: 'claimed',
        })

        const advanced = await advanceJobFlow({
          deps: {
            ...deps,
            hrcClient: hrcClientForFreshStep({
              order,
              failIfRotated: true,
              terminate: () => {
                throw new Error('inside-window run must not pre-clean')
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
        const stepRun = jobsStore.jobStepRuns.getById(
          jobRun.jobRunId,
          'sequence',
          'fresh-start',
          1
        ).jobStepRun
        const run = deps.runStore.getRun(stepRun?.runId ?? '')
        expect(run?.metadata?.['scheduledFresh']).toEqual({
          jobId: job.jobId,
          phase: 'sequence',
          stepId: 'fresh-start',
          freshDuration: 'PT24H',
          windowStartedAt: '2026-04-28T12:00:00.000Z',
        })
      },
      [{ status: 'completed' }]
    )
  })

  test('at the freshDuration boundary terminates the prior runtime and starts a new window', async () => {
    await withFlowHarness(
      async ({ deps, jobsStore, order }) => {
        const job = createFlowJob(jobsStore, {
          sequence: [
            {
              id: 'fresh-start',
              input: 'rotate at duration boundary',
              fresh: true,
              freshDuration: 'PT24H',
            },
          ],
        })
        seedPriorStepRun({
          deps,
          jobsStore,
          job,
          jobRunId: 'jrun_prior_boundary',
          stepId: 'fresh-start',
          triggeredAt: '2026-04-28T12:00:00.000Z',
          runtimeId: 'rt-prior-boundary',
          runMetadata: scheduledFreshRunMetadata({
            job,
            windowStartedAt: '2026-04-28T12:00:00.000Z',
          }),
        })
        const terminateCalls: Array<{ runtimeId: string; options: unknown }> = []
        const jobRun = createJobRun(jobsStore, job.jobId, {
          jobRunId: 'jrun_boundary',
          triggeredAt: '2026-04-29T12:00:00.000Z',
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
          now: '2026-04-29T12:00:00.000Z',
        })

        expect(advanced.status).toBe('succeeded')
        expect(order).toEqual([
          'terminate:rt-prior-boundary',
          'resolveSession',
          'clearContext',
          'dispatch',
        ])
        expect(terminateCalls.map((call) => call.runtimeId)).toEqual(['rt-prior-boundary'])
        const stepRun = jobsStore.jobStepRuns.getById(
          jobRun.jobRunId,
          'sequence',
          'fresh-start',
          1
        ).jobStepRun
        const run = deps.runStore.getRun(stepRun?.runId ?? '')
        expect(run?.metadata?.['scheduledFresh']).toMatchObject({
          freshDuration: 'PT24H',
          windowStartedAt: '2026-04-29T12:00:00.000Z',
        })
      },
      [{ status: 'completed' }]
    )
  })

  test('missing metadata and changed duration rotate once and seed explicit metadata', async () => {
    for (const prior of [
      { name: 'missing-metadata', metadata: undefined },
      { name: 'duration-mismatch', metadata: 'mismatch' },
    ] as const) {
      await withFlowHarness(
        async ({ deps, jobsStore, order }) => {
          const job = createFlowJob(jobsStore, {
            sequence: [
              {
                id: 'fresh-start',
                input: `rotate for ${prior.name}`,
                fresh: true,
                freshDuration: 'PT24H',
              },
            ],
          })
          seedPriorStepRun({
            deps,
            jobsStore,
            job,
            jobRunId: `jrun_prior_${prior.name}`,
            stepId: 'fresh-start',
            triggeredAt: '2026-04-28T12:00:00.000Z',
            runtimeId: `rt-prior-${prior.name}`,
            ...(prior.metadata === 'mismatch'
              ? {
                  runMetadata: scheduledFreshRunMetadata({
                    job,
                    freshDuration: 'PT1H',
                    windowStartedAt: '2026-04-28T12:00:00.000Z',
                  }),
                }
              : {}),
          })
          const jobRun = createJobRun(jobsStore, job.jobId, {
            jobRunId: `jrun_current_${prior.name}`,
            triggeredAt: '2026-04-28T12:20:00.000Z',
            triggeredBy: 'schedule',
            status: 'claimed',
          })

          const advanced = await advanceJobFlow({
            deps: {
              ...deps,
              hrcClient: hrcClientForFreshStep({ order }),
            } as never,
            job,
            jobRun,
            actor: { kind: 'system', id: 'flow-engine-test' },
            now: '2026-04-28T12:21:00.000Z',
          })

          expect(advanced.status).toBe('succeeded')
          expect(order).toEqual([
            `terminate:rt-prior-${prior.name}`,
            'resolveSession',
            'clearContext',
            'dispatch',
          ])
          const stepRun = jobsStore.jobStepRuns.getById(
            jobRun.jobRunId,
            'sequence',
            'fresh-start',
            1
          ).jobStepRun
          const run = deps.runStore.getRun(stepRun?.runId ?? '')
          expect(run?.metadata?.['scheduledFresh']).toMatchObject({
            freshDuration: 'PT24H',
            windowStartedAt: '2026-04-28T12:21:00.000Z',
          })
        },
        [{ status: 'completed' }]
      )
    }
  })

  test('newest prior same-identity step still running fails closed without dispatch', async () => {
    await withFlowHarness(async ({ deps, jobsStore, inputAttemptStore, launchCalls, order }) => {
      const job = createFlowJob(jobsStore, {
        sequence: [
          {
            id: 'fresh-start',
            input: 'must not overlap retained runtime',
            fresh: true,
            freshDuration: 'PT24H',
          },
        ],
      })
      seedPriorStepRun({
        deps,
        jobsStore,
        job,
        jobRunId: 'jrun_prior_running',
        stepId: 'fresh-start',
        triggeredAt: '2026-04-28T12:00:00.000Z',
        stepStatus: 'running',
        jobRunStatus: 'running',
        runStatus: 'running',
        runtimeId: 'rt-prior-running',
        runMetadata: scheduledFreshRunMetadata({
          job,
          windowStartedAt: '2026-04-28T12:00:00.000Z',
        }),
      })
      const jobRun = createJobRun(jobsStore, job.jobId, {
        jobRunId: 'jrun_current_running',
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
          message: 'previous fresh step jrun_prior_running/sequence/fresh-start is still running',
        },
      })
    })
  })

  test('manual and webhook freshDuration runs preserve ordinary fresh rotation without pre-clean', async () => {
    for (const triggeredBy of ['manual', 'webhook'] as const) {
      await withFlowHarness(
        async ({ deps, jobsStore, order }) => {
          const job = createFlowJob(jobsStore, {
            sequence: [
              {
                id: 'fresh-start',
                input: 'manual debug run',
                fresh: true,
                freshDuration: 'PT24H',
              },
            ],
          })
          seedPriorStepRun({
            deps,
            jobsStore,
            job,
            jobRunId: `jrun_prior_${triggeredBy}_duration`,
            stepId: 'fresh-start',
            triggeredAt: '2026-04-28T12:00:00.000Z',
            runtimeId: `rt-prior-${triggeredBy}-duration`,
            runMetadata: scheduledFreshRunMetadata({
              job,
              windowStartedAt: '2026-04-28T12:00:00.000Z',
            }),
          })
          const jobRun = createJobRun(jobsStore, job.jobId, {
            jobRunId: `jrun_current_${triggeredBy}_duration`,
            triggeredAt: '2026-04-28T12:20:00.000Z',
            triggeredBy,
            status: 'claimed',
          })

          const advanced = await advanceJobFlow({
            deps: {
              ...deps,
              hrcClient: hrcClientForFreshStep({
                order,
                terminate: () => {
                  throw new Error('manual/webhook duration runs must not pre-clean')
                },
              }),
            } as never,
            job,
            jobRun,
            actor: { kind: 'system', id: 'flow-engine-test' },
            now: '2026-04-28T12:21:00.000Z',
          })

          expect(advanced.status).toBe('succeeded')
          expect(order).toEqual(['resolveSession', 'clearContext', 'dispatch'])
        },
        [{ status: 'completed' }]
      )
    }
  })
})

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
})
