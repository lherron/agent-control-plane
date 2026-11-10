import { Database } from 'bun:sqlite'
import { expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type AcpServerDeps, type HrcRouteReader, InMemoryInputAttemptStore } from 'acp-server'

import type { SeedStack } from './seed-stack.js'

export type LaunchCall = Parameters<NonNullable<AcpServerDeps['launchRoleScopedRun']>>[0]

export type FlowLaunchOutcome = {
  status: 'completed' | 'failed' | 'cancelled'
  text: string
}

export type HeadlessHrcFixture = {
  db: Database
  /** HRC's read routes, served from this fixture's tables (T-13243). */
  hrcRoutes: HrcRouteReader
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

/**
 * HRC's `/v1/runs` and `/v1/events` routes over this fixture's tables, in the
 * wire shape real calls return (T-13243): the jobflow path reads a headless
 * run's status and its turn.message/turn.completed events by run id.
 */
function fixtureRoutes(db: Database): HrcRouteReader {
  type RunRow = {
    run_id: string
    status: string
    error_code: string | null
    error_message: string | null
  }
  type EventRow = {
    hrc_seq: number
    run_id: string | null
    event_kind: string
    payload_json: string
  }
  return {
    async readRuns(q) {
      return db
        .query<RunRow, []>('SELECT * FROM runs')
        .all()
        .filter((r) => q.runId === undefined || r.run_id === q.runId)
        .map((r) => ({
          runId: r.run_id,
          status: r.status,
          ...(r.error_code !== null ? { errorCode: r.error_code } : {}),
          ...(r.error_message !== null ? { errorMessage: r.error_message } : {}),
        }))
    },
    async readEvents(q) {
      return db
        .query<EventRow, []>('SELECT * FROM hrc_events ORDER BY hrc_seq')
        .all()
        .filter(
          (e) =>
            (q.runId === undefined || e.run_id === q.runId) &&
            (q.eventKind === undefined || q.eventKind.includes(e.event_kind))
        )
        .map((e) => ({
          hrcSeq: e.hrc_seq,
          ts: '2026-01-01T00:00:00.000Z',
          eventKind: e.event_kind,
          ...(e.run_id !== null ? { runId: e.run_id } : {}),
          payload: JSON.parse(e.payload_json),
        }))
    },
    async readEventTail() {
      return { events: [], headHrcSeq: 0, truncated: false }
    },
    async readRuntimes() {
      return []
    },
    async readActiveHostSessionId() {
      return undefined
    },
  }
}

export function createHeadlessHrcDb(prefix = 'acp-e2e-jobflow-'): HeadlessHrcFixture {
  const fixtureDir = mkdtempSync(join(tmpdir(), prefix))
  const hrcFixture = join(fixtureDir, 'hrc.sqlite')
  const db = new Database(hrcFixture)

  db.exec(`
    CREATE TABLE runs (
      run_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      error_code TEXT,
      error_message TEXT
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
    hrcRoutes: fixtureRoutes(db),
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
