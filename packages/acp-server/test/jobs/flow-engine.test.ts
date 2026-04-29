import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ExecStepResult, JobFlow, JobFlowStep } from 'acp-core'
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
    'jobsStore' | 'inputAttemptStore' | 'jobExecPolicy' | 'runtimeResolver' | 'launchRoleScopedRun'
  > & { hrcDbPath: string }

type FlowLaunchOutcome = {
  status: 'completed' | 'failed' | 'cancelled' | 'running'
  text?: string | undefined
}

type HeadlessHrcFixture = {
  db: Database
  hrcDbPath: string
  cleanup(): void
}

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
      })
    } else {
      insertHrcRun(hrc, hrcRunId, outcome)
      input.runStore?.updateRun(acpRunId, {
        status: outcome.status,
        hrcRunId,
        hostSessionId: 'hsid-flow-engine',
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
    scopeRef: 'agent:larry:project:demo-project:task:T-01319:role:implementer',
    laneRef: 'main',
    schedule: { cron: '*/5 * * * *' },
    input: { content: 'legacy input must not dispatch for flow jobs' },
    flow,
    disabled: false,
    createdAt: '2026-04-28T12:00:00.000Z',
  }).job
}

function createJobRun(store: JobsStore, jobId: string) {
  return store.appendJobRun({
    jobId,
    jobRunId: `jrun_${jobId}`,
    triggeredAt: '2026-04-28T12:00:00.000Z',
    triggeredBy: 'manual',
    status: 'claimed',
  }).jobRun
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
  const launchRoleScopedRun = createFlowLauncher(hrc, outcomes, launchCalls, order)
  const runtimeResolver: NonNullable<AcpServerDeps['runtimeResolver']> = async () => ({
    agentRoot: '/tmp/agents/larry',
    projectRoot: process.cwd(),
    cwd: process.cwd(),
    runMode: 'task',
    bundle: { kind: 'agent-default' },
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
        hrcDbPath: hrc.hrcDbPath,
        jobExecPolicy,
        runtimeResolver,
        launchRoleScopedRun,
      }
    )
  } finally {
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

describe('advanceJobFlow exec steps', () => {
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
                return { hostSessionId: 'hsid-fresh' }
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

describe('advanceJobFlow exec resume/replay', () => {
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
