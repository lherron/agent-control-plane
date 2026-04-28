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
  const fixtureDir = mkdtempSync(join(tmpdir(), 'acp-e2e-jobflow-'))
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
      hostSessionId: 'session-jobflow-e2e',
    })

    return {
      runId: hrcRunId,
      sessionId: 'session-jobflow-e2e',
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
      scopeRef: `agent:larry:project:${stack.seed.projectId}:task:T-01314:role:implementer`,
      laneRef: 'main',
      schedule: { cron: '*/5 * * * *' },
      input: { content: 'run the jobflow acceptance test' },
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

describe('JobFlow MVP e2e', () => {
  test('runs two terminal sequence steps and exposes parsed results through GET /v1/job-runs/:jobRunId', async () => {
    const jobsStore = createInMemoryJobsStore()
    const runStore = new InMemoryRunStore()
    const inputAttemptStore = new RecordingInputAttemptStore()
    const hrc = createHeadlessHrcDb()
    const launchCalls: LaunchCall[] = []

    try {
      await withSeedStack(
        async (stack) => {
          const jobId = await createFlowJob(stack, {
            sequence: [
              {
                id: 'work',
                input: 'Complete the work step.',
                expect: {
                  outcome: 'succeeded',
                  resultBlock: 'WORK_RESULT',
                  require: ['step', 'summary', 'ready'],
                  equals: { step: 'work', ready: true },
                },
              },
              {
                id: 'closeout',
                input: 'Complete the closeout step.',
                expect: {
                  outcome: 'succeeded',
                  resultBlock: 'CLOSEOUT_RESULT',
                  require: ['step', 'summary', 'ready'],
                  equals: { step: 'closeout', ready: true },
                },
              },
            ],
          })

          const jobRunId = await runJob(stack, jobId)
          const payload = await getJobRun(stack, jobRunId)
          const steps = payload.jobRun.steps

          expect(payload.jobRun.status).toBe('succeeded')
          expect(steps.map((step) => [step.phase, step.stepId, step.status])).toEqual([
            ['sequence', 'work', 'succeeded'],
            ['sequence', 'closeout', 'succeeded'],
          ])
          expect(steps[0]).toMatchObject({
            attempt: 1,
            inputAttemptId: expect.any(String),
            runId: expect.any(String),
            resultBlock: 'WORK_RESULT',
            result: { step: 'work', summary: 'work finished', ready: true },
          })
          expect(steps[1]).toMatchObject({
            attempt: 1,
            inputAttemptId: expect.any(String),
            runId: expect.any(String),
            resultBlock: 'CLOSEOUT_RESULT',
            result: { step: 'closeout', summary: 'closeout finished', ready: true },
          })
          expect(steps[0]?.runId).not.toBe(steps[1]?.runId)
          expect(steps[0]?.inputAttemptId).not.toBe(steps[1]?.inputAttemptId)
          expect(inputAttemptStore.calls.map((call) => call.idempotencyKey)).toEqual([
            `jobrun:${jobRunId}:phase:sequence:step:work:attempt:1`,
            `jobrun:${jobRunId}:phase:sequence:step:closeout:attempt:1`,
          ])
          expect(launchCalls).toHaveLength(2)
        },
        {
          jobsStore,
          runStore,
          inputAttemptStore,
          hrcDbPath: hrc.hrcDbPath,
          launchRoleScopedRun: createTerminalFlowLauncher(
            hrc,
            [
              {
                status: 'completed',
                text: 'WORK_RESULT\n{"step":"work","summary":"work finished","ready":true}',
              },
              {
                status: 'completed',
                text: 'CLOSEOUT_RESULT\n{"step":"closeout","summary":"closeout finished","ready":true}',
              },
            ],
            launchCalls
          ),
        }
      )
    } finally {
      hrc.cleanup()
      jobsStore.close()
    }
  })

  test('fails on missing required result field and runs onFailure when configured', async () => {
    const jobsStore = createInMemoryJobsStore()
    const runStore = new InMemoryRunStore()
    const inputAttemptStore = new RecordingInputAttemptStore()
    const hrc = createHeadlessHrcDb()
    const launchCalls: LaunchCall[] = []

    try {
      await withSeedStack(
        async (stack) => {
          const jobId = await createFlowJob(stack, {
            sequence: [
              {
                id: 'work',
                input: 'Complete the work step.',
                expect: {
                  outcome: 'succeeded',
                  resultBlock: 'WORK_RESULT',
                  require: ['step', 'summary', 'ready'],
                  equals: { step: 'work', ready: true },
                },
              },
              {
                id: 'closeout',
                input: 'Complete the closeout step.',
                expect: {
                  outcome: 'succeeded',
                  resultBlock: 'CLOSEOUT_RESULT',
                  require: ['step', 'summary', 'ready'],
                  equals: { step: 'closeout', ready: true },
                },
              },
            ],
            onFailure: [
              {
                id: 'notify',
                input: 'Notify that the JobFlow failed.',
                expect: {
                  outcome: 'succeeded',
                  resultBlock: 'FAILURE_RESULT',
                  require: ['notified'],
                  equals: { notified: true },
                },
              },
            ],
          })

          const jobRunId = await runJob(stack, jobId)
          const payload = await getJobRun(stack, jobRunId)
          const steps = payload.jobRun.steps

          expect(payload.jobRun.status).toBe('failed')
          expect(payload.jobRun.errorCode).toBe('required_result_field_missing')
          expect(steps.map((step) => [step.phase, step.stepId, step.status])).toEqual([
            ['sequence', 'work', 'succeeded'],
            ['sequence', 'closeout', 'failed'],
            ['onFailure', 'notify', 'succeeded'],
          ])
          expect(steps[1]).toMatchObject({
            resultBlock: 'CLOSEOUT_RESULT',
            result: { step: 'closeout', ready: true },
            error: { code: 'required_result_field_missing' },
          })
          expect(steps[2]).toMatchObject({
            resultBlock: 'FAILURE_RESULT',
            result: { notified: true },
            inputAttemptId: expect.any(String),
            runId: expect.any(String),
          })
          expect(inputAttemptStore.calls.map((call) => call.idempotencyKey)).toEqual([
            `jobrun:${jobRunId}:phase:sequence:step:work:attempt:1`,
            `jobrun:${jobRunId}:phase:sequence:step:closeout:attempt:1`,
            `jobrun:${jobRunId}:phase:onFailure:step:notify:attempt:1`,
          ])
          expect(launchCalls).toHaveLength(3)
        },
        {
          jobsStore,
          runStore,
          inputAttemptStore,
          hrcDbPath: hrc.hrcDbPath,
          launchRoleScopedRun: createTerminalFlowLauncher(
            hrc,
            [
              {
                status: 'completed',
                text: 'WORK_RESULT\n{"step":"work","summary":"work finished","ready":true}',
              },
              {
                status: 'completed',
                text: 'CLOSEOUT_RESULT\n{"step":"closeout","ready":true}',
              },
              {
                status: 'completed',
                text: 'FAILURE_RESULT\n{"notified":true}',
              },
            ],
            launchCalls
          ),
        }
      )
    } finally {
      hrc.cleanup()
      jobsStore.close()
    }
  })
})
