import { Database } from 'bun:sqlite'
import { expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type AcpServerDeps, InMemoryInputAttemptStore } from 'acp-server'

import type { SeedStack } from './seed-stack.js'

export type LaunchCall = Parameters<NonNullable<AcpServerDeps['launchRoleScopedRun']>>[0]

export type FlowLaunchOutcome = {
  status: 'completed' | 'failed' | 'cancelled'
  text: string
}

export type HeadlessHrcFixture = {
  db: Database
  hrcDbPath: string
  cleanup(): void
}

/**
 * Shape of the `result` captured for an `exec` flow step. Documents the exec
 * value object the suites pin via `expect.objectContaining`; the index
 * signature keeps it assignment-compatible with the parsed agent-result bag
 * that the same field also carries for non-exec steps.
 */
export type ExecStepResult = {
  kind: 'exec'
  argv: string[]
  cwd: string
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
  [key: string]: unknown
}

export type JobRunStepPayload = {
  phase: string
  stepId: string
  status: string
  attempt: number
  inputAttemptId?: string | undefined
  runId?: string | undefined
  result?: ExecStepResult | Record<string, unknown> | undefined
  resultBlock?: string | undefined
  error?: { code: string; message: string } | undefined
}

export type JobRunPayload = {
  jobRun: {
    jobRunId: string
    status: string
    errorCode?: string | undefined
    steps: JobRunStepPayload[]
  }
}

export class RecordingInputAttemptStore extends InMemoryInputAttemptStore {
  readonly calls: Array<Parameters<InMemoryInputAttemptStore['createAttempt']>[0]> = []

  override createAttempt(input: Parameters<InMemoryInputAttemptStore['createAttempt']>[0]) {
    this.calls.push(input)
    return super.createAttempt(input)
  }
}

export function createHeadlessHrcDb(prefix = 'acp-e2e-jobflow-'): HeadlessHrcFixture {
  const fixtureDir = mkdtempSync(join(tmpdir(), prefix))
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

export function insertTerminalHrcRun(
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
  hrc.db
    .prepare('INSERT INTO hrc_events (run_id, event_kind, payload_json) VALUES (?, ?, ?)')
    .run(hrcRunId, 'turn.completed', JSON.stringify({ finalOutput: outcome.text }))
}

export function createTerminalFlowLauncher(
  hrc: HeadlessHrcFixture,
  outcomes: FlowLaunchOutcome[],
  calls: LaunchCall[],
  options: { sessionId?: string } = {}
): NonNullable<AcpServerDeps['launchRoleScopedRun']> {
  const sessionId = options.sessionId ?? 'session-jobflow-e2e'
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
      hostSessionId: sessionId,
    })

    return {
      runId: hrcRunId,
      sessionId,
    }
  }
}

export async function createFlowJob(
  stack: SeedStack,
  flow: Record<string, unknown>,
  options: { scopeRefTask?: string; content?: string } = {}
): Promise<string> {
  const scopeRefTask = options.scopeRefTask ?? 'T-01314'
  const content = options.content ?? 'run the jobflow acceptance test'
  const response = await stack.cli.request({
    method: 'POST',
    path: '/v1/admin/jobs',
    body: {
      agentId: 'larry',
      projectId: stack.seed.projectId,
      scopeRef: `agent:larry:project:${stack.seed.projectId}:task:${scopeRefTask}:role:implementer`,
      laneRef: 'main',
      schedule: { cron: '*/5 * * * *' },
      input: { content },
      flow,
    },
  })
  const payload = (await response.json()) as { job: { jobId: string } }

  expect(response.status).toBe(201)
  return payload.job.jobId
}

export async function runJob(stack: SeedStack, jobId: string): Promise<string> {
  const response = await stack.cli.request({
    method: 'POST',
    path: `/v1/admin/jobs/${jobId}/run`,
  })
  const payload = (await response.json()) as { jobRun: { jobRunId: string } }

  expect(response.status).toBe(202)
  return payload.jobRun.jobRunId
}

export async function getJobRun(stack: SeedStack, jobRunId: string): Promise<JobRunPayload> {
  const response = await stack.cli.request({
    method: 'GET',
    path: `/v1/job-runs/${jobRunId}`,
  })
  const payload = (await response.json()) as JobRunPayload

  expect(response.status).toBe(200)
  return payload
}
