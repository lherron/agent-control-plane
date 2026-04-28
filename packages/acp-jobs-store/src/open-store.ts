import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import type { Actor, JobFlow, JobStepRunPhase, JobStepRunStatus } from 'acp-core'

import { isValidCron, nextFireAfter } from './cron.js'
import Database, { type SqliteDatabase } from './sqlite.js'

type MigrationRow = {
  id: string
}

type JobRow = {
  job_id: string
  project_id: string
  agent_id: string
  scope_ref: string
  lane_ref: string
  schedule_cron: string
  schedule_window_start: string | null
  schedule_window_end: string | null
  schedule_json: string
  input_json: string
  flow_json: string | null
  disabled: number
  last_fire_at: string | null
  next_fire_at: string | null
  actor_kind: Actor['kind'] | null
  actor_id: string | null
  actor_display_name: string | null
  actor_stamp: string
  created_at: string
  updated_at: string
  archived_at: string | null
}

type JobRunRow = {
  job_run_id: string
  job_id: string
  triggered_at: string
  triggered_by: JobRunTrigger
  status: JobRunStatus
  input_attempt_id: string | null
  run_id: string | null
  error_code: string | null
  error_message: string | null
  lease_owner: string | null
  lease_expires_at: string | null
  claimed_at: string | null
  dispatched_at: string | null
  completed_at: string | null
  actor_kind: Actor['kind'] | null
  actor_id: string | null
  actor_display_name: string | null
  actor_stamp: string
  created_at: string
  updated_at: string
}

type JobStepRunRow = {
  job_run_id: string
  phase: JobStepRunPhase
  step_id: string
  status: JobStepRunStatus
  attempt: number
  input_attempt_id: string | null
  run_id: string | null
  result_block: string | null
  result_json: string | null
  error_code: string | null
  error_message: string | null
  started_at: string | null
  completed_at: string | null
  created_at: string
  updated_at: string
}

export type JobsStoreMigration = {
  id: string
  sql: string
}

export type JobRunTrigger = 'schedule' | 'manual' | 'catch-up'

export type JobRunStatus = 'pending' | 'claimed' | 'dispatched' | 'succeeded' | 'failed' | 'skipped'

export type JobSchedule = Readonly<{
  cron: string
  windowStart?: string | undefined
  windowEnd?: string | undefined
  windowMinutes?: number | undefined
  [key: string]: unknown
}>

export type JobInputTemplate = Readonly<Record<string, unknown>>

export type JobRecord = {
  jobId: string
  projectId: string
  agentId: string
  scopeRef: string
  laneRef: string
  schedule: JobSchedule
  input: JobInputTemplate
  flow?: JobFlow | undefined
  disabled: boolean
  lastFireAt?: string | undefined
  nextFireAt?: string | undefined
  actor: Actor
  actorStamp?: string | undefined
  createdAt: string
  updatedAt: string
}

export type JobStepRunRecord = {
  jobRunId: string
  stepId: string
  phase: JobStepRunPhase
  status: JobStepRunStatus
  attempt: number
  inputAttemptId?: string | undefined
  runId?: string | undefined
  resultBlock?: string | undefined
  result?: Readonly<Record<string, unknown>> | undefined
  error?: { code: string; message: string } | undefined
  startedAt?: string | undefined
  completedAt?: string | undefined
  createdAt: string
  updatedAt: string
}

export type JobRunRecord = {
  jobRunId: string
  jobId: string
  triggeredAt: string
  triggeredBy: JobRunTrigger
  status: JobRunStatus
  inputAttemptId?: string | undefined
  runId?: string | undefined
  errorCode?: string | undefined
  errorMessage?: string | undefined
  leaseOwner?: string | undefined
  leaseExpiresAt?: string | undefined
  claimedAt?: string | undefined
  dispatchedAt?: string | undefined
  completedAt?: string | undefined
  actor: Actor
  actorStamp?: string | undefined
  createdAt: string
  updatedAt: string
}

export type CreateJobInput = {
  jobId?: string | undefined
  projectId: string
  agentId: string
  scopeRef: string
  laneRef?: string | undefined
  schedule: JobSchedule
  input: JobInputTemplate
  flow?: JobFlow | undefined
  disabled?: boolean | undefined
  actor?: Actor | undefined
  actorStamp?: string | undefined
  createdAt?: string | undefined
}

export type UpdateJobInput = {
  schedule?: JobSchedule | undefined
  input?: JobInputTemplate | undefined
  flow?: JobFlow | undefined
  disabled?: boolean | undefined
  actor?: Actor | undefined
  actorStamp?: string | undefined
}

export type InsertJobStepRunInput = {
  stepId: string
  status?: JobStepRunStatus | undefined
  attempt?: number | undefined
  inputAttemptId?: string | undefined
  runId?: string | undefined
  resultBlock?: string | undefined
  result?: Readonly<Record<string, unknown>> | undefined
  error?: { code: string; message: string } | undefined
  startedAt?: string | undefined
  completedAt?: string | undefined
}

export type UpdateJobStepRunInput = {
  status?: JobStepRunStatus | undefined
  inputAttemptId?: string | null | undefined
  runId?: string | null | undefined
  resultBlock?: string | null | undefined
  result?: Readonly<Record<string, unknown>> | null | undefined
  error?: { code: string; message: string } | null | undefined
  startedAt?: string | null | undefined
  completedAt?: string | null | undefined
}

export type ListJobsInput = {
  projectId?: string | undefined
}

export type AppendJobRunInput = {
  jobRunId?: string | undefined
  jobId: string
  triggeredAt: string
  triggeredBy: JobRunTrigger
  status: JobRunStatus
  inputAttemptId?: string | undefined
  runId?: string | undefined
  errorCode?: string | undefined
  errorMessage?: string | undefined
  leaseOwner?: string | undefined
  leaseExpiresAt?: string | undefined
  claimedAt?: string | undefined
  dispatchedAt?: string | undefined
  completedAt?: string | undefined
  actor?: Actor | undefined
  actorStamp?: string | undefined
}

export type UpdateJobRunInput = {
  status?: JobRunStatus | undefined
  inputAttemptId?: string | undefined
  runId?: string | undefined
  errorCode?: string | undefined
  errorMessage?: string | undefined
  leaseOwner?: string | null | undefined
  leaseExpiresAt?: string | null | undefined
  claimedAt?: string | undefined
  dispatchedAt?: string | undefined
  completedAt?: string | undefined
  actor?: Actor | undefined
  actorStamp?: string | undefined
}

export type ClaimDueJobRunsInput = {
  now: string
  limit: number
  leaseOwner: string
  leaseExpiresAt: string
}

export type ClaimedDueJob = {
  job: JobRecord
  jobRun: JobRunRecord
}

export type ClaimDueJobsInput = {
  now: string
  limit?: number | undefined
  actor?: Actor | undefined
  actorStamp?: string | undefined
}

export const jobsStoreMigrations: readonly JobsStoreMigration[] = [
  {
    id: '001_initial',
    sql: `
      CREATE TABLE IF NOT EXISTS jobs (
        job_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        scope_ref TEXT NOT NULL,
        lane_ref TEXT NOT NULL,
        schedule_cron TEXT NOT NULL,
        schedule_window_start TEXT,
        schedule_window_end TEXT,
        schedule_json TEXT NOT NULL,
        input_json TEXT NOT NULL,
        disabled INTEGER NOT NULL DEFAULT 0,
        last_fire_at TEXT,
        next_fire_at TEXT,
        actor_stamp TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT
      );

      CREATE INDEX IF NOT EXISTS jobs_project_id_idx ON jobs (project_id);
      CREATE INDEX IF NOT EXISTS jobs_next_fire_at_idx ON jobs (next_fire_at) WHERE archived_at IS NULL AND disabled = 0;

      CREATE TABLE IF NOT EXISTS job_runs (
        job_run_id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        triggered_at TEXT NOT NULL,
        triggered_by TEXT NOT NULL,
        status TEXT NOT NULL,
        input_attempt_id TEXT,
        run_id TEXT,
        error_code TEXT,
        error_message TEXT,
        lease_owner TEXT,
        lease_expires_at TEXT,
        claimed_at TEXT,
        dispatched_at TEXT,
        completed_at TEXT,
        actor_stamp TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS job_runs_job_id_idx ON job_runs (job_id, triggered_at DESC);
      CREATE INDEX IF NOT EXISTS job_runs_triggered_at_idx ON job_runs (triggered_at);
      CREATE INDEX IF NOT EXISTS job_runs_claimable_idx ON job_runs (status, triggered_at, lease_expires_at);
    `,
  },
  {
    id: '002_actor_columns',
    sql: `
      ALTER TABLE jobs ADD COLUMN actor_kind TEXT;
      ALTER TABLE jobs ADD COLUMN actor_id TEXT;
      ALTER TABLE jobs ADD COLUMN actor_display_name TEXT;
      UPDATE jobs
         SET actor_kind = COALESCE(actor_kind, 'system'),
             actor_id = COALESCE(actor_id, actor_stamp)
       WHERE actor_kind IS NULL OR actor_id IS NULL;

      ALTER TABLE job_runs ADD COLUMN actor_kind TEXT;
      ALTER TABLE job_runs ADD COLUMN actor_id TEXT;
      ALTER TABLE job_runs ADD COLUMN actor_display_name TEXT;
      UPDATE job_runs
         SET actor_kind = COALESCE(actor_kind, 'system'),
             actor_id = COALESCE(actor_id, actor_stamp)
       WHERE actor_kind IS NULL OR actor_id IS NULL;
    `,
  },
  {
    id: '003_job_flow',
    sql: `
      ALTER TABLE jobs ADD COLUMN flow_json TEXT;

      CREATE TABLE IF NOT EXISTS job_step_runs (
        job_run_id TEXT NOT NULL,
        phase TEXT NOT NULL,
        step_id TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        input_attempt_id TEXT,
        run_id TEXT,
        result_block TEXT,
        result_json TEXT,
        error_code TEXT,
        error_message TEXT,
        started_at TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (job_run_id, phase, step_id, attempt),
        FOREIGN KEY (job_run_id) REFERENCES job_runs(job_run_id)
      );

      CREATE INDEX IF NOT EXISTS job_step_runs_job_run_idx
        ON job_step_runs (job_run_id, phase, created_at, step_id);

      CREATE INDEX IF NOT EXISTS job_step_runs_run_id_idx
        ON job_step_runs (run_id)
        WHERE run_id IS NOT NULL;
    `,
  },
]

export interface OpenSqliteJobsStoreOptions {
  dbPath: string
}

export interface JobsStore {
  readonly sqlite: SqliteDatabase
  readonly migrations: {
    applied: string[]
  }
  readonly jobs: {
    create(input: CreateJobInput): { job: JobRecord }
    list(input?: ListJobsInput | undefined): { jobs: JobRecord[] }
    get(jobId: string): { job: JobRecord | undefined }
    update(jobId: string, patch: UpdateJobInput): { job: JobRecord }
    archive(jobId: string): void
  }
  readonly jobRuns: {
    append(input: AppendJobRunInput): { jobRun: JobRunRecord }
    listByJob(jobId: string): { jobRuns: JobRunRecord[] }
    get(jobRunId: string): { jobRun: JobRunRecord | undefined }
    update(jobRunId: string, patch: UpdateJobRunInput): { jobRun: JobRunRecord }
    claimDueRuns(input: ClaimDueJobRunsInput): { jobRuns: JobRunRecord[] }
  }
  readonly jobStepRuns: {
    insertMany(
      jobRunId: string,
      phase: JobStepRunPhase,
      steps: readonly InsertJobStepRunInput[]
    ): { jobStepRuns: JobStepRunRecord[] }
    updateStep(
      jobRunId: string,
      phase: JobStepRunPhase,
      stepId: string,
      attempt: number,
      patch: UpdateJobStepRunInput
    ): { jobStepRun: JobStepRunRecord }
    listByJobRun(jobRunId: string): { jobStepRuns: JobStepRunRecord[] }
    getById(
      jobRunId: string,
      phase: JobStepRunPhase,
      stepId: string,
      attempt: number
    ): { jobStepRun: JobStepRunRecord | undefined }
  }
  createJob(input: CreateJobInput): { job: JobRecord }
  listJobs(input?: ListJobsInput | undefined): { jobs: JobRecord[] }
  getJob(jobId: string): { job: JobRecord | undefined }
  updateJob(jobId: string, patch: UpdateJobInput): { job: JobRecord }
  archiveJob(jobId: string): void
  appendJobRun(input: AppendJobRunInput): { jobRun: JobRunRecord }
  listJobRuns(jobId: string): { jobRuns: JobRunRecord[] }
  getJobRun(jobRunId: string): { jobRun: JobRunRecord | undefined }
  updateJobRun(jobRunId: string, patch: UpdateJobRunInput): { jobRun: JobRunRecord }
  claimDueJobRuns(input: ClaimDueJobRunsInput): { jobRuns: JobRunRecord[] }
  insertJobStepRuns(
    jobRunId: string,
    phase: JobStepRunPhase,
    steps: readonly InsertJobStepRunInput[]
  ): { jobStepRuns: JobStepRunRecord[] }
  updateJobStepRun(
    jobRunId: string,
    phase: JobStepRunPhase,
    stepId: string,
    attempt: number,
    patch: UpdateJobStepRunInput
  ): { jobStepRun: JobStepRunRecord }
  listJobStepRuns(jobRunId: string): { jobStepRuns: JobStepRunRecord[] }
  getJobStepRun(
    jobRunId: string,
    phase: JobStepRunPhase,
    stepId: string,
    attempt: number
  ): { jobStepRun: JobStepRunRecord | undefined }
  createJobRun(
    jobId: string,
    input: Omit<AppendJobRunInput, 'jobId'>
  ): { job: JobRecord; jobRun: JobRunRecord }
  claimDueJobs(input: ClaimDueJobsInput): ClaimedDueJob[]
  listInflightFlowJobRuns(input?: { limit?: number | undefined } | undefined): ClaimedDueJob[]
  runInTransaction<T>(fn: (store: JobsStore) => T): T
  close(): void
}

function isEphemeralPath(path: string): boolean {
  return path === '' || path === ':memory:'
}

function ensureMigrationTable(sqlite: SqliteDatabase): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS acp_jobs_store_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `)
}

function createSqliteDatabase(dbPath: string): SqliteDatabase {
  if (!isEphemeralPath(dbPath)) {
    mkdirSync(dirname(dbPath), { recursive: true })
  }

  const sqlite = new Database(dbPath)
  sqlite.exec('PRAGMA journal_mode = WAL;')
  sqlite.exec('PRAGMA foreign_keys = ON;')
  sqlite.exec('PRAGMA busy_timeout = 5000;')
  return sqlite
}

function toIsoString(value?: string | Date | undefined): string {
  const resolved = value instanceof Date ? value : new Date(value ?? Date.now())
  return resolved.toISOString()
}

function parseJsonRecord(value: string, field: string): Readonly<Record<string, unknown>> {
  const parsed = JSON.parse(value) as unknown
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${field} must decode to an object`)
  }

  return parsed as Readonly<Record<string, unknown>>
}

function parseOptionalJsonRecord(
  value: string | null,
  field: string
): Readonly<Record<string, unknown>> | undefined {
  return value === null ? undefined : parseJsonRecord(value, field)
}

function actorToStamp(actor: Actor): string {
  return `${actor.kind}:${actor.id}`
}

function resolveActor(actor?: Actor | undefined): Actor {
  return actor ?? { kind: 'system', id: 'acp-local' }
}

function rowToActor(row: {
  actor_kind: Actor['kind'] | null
  actor_id: string | null
  actor_display_name: string | null
  actor_stamp: string
}): Actor {
  const displayName = row.actor_display_name
  return {
    kind: (row.actor_kind ?? 'system') as Actor['kind'],
    id: row.actor_id ?? row.actor_stamp,
    ...(displayName !== null ? { displayName } : {}),
  }
}

function toJobRecord(row: JobRow): JobRecord {
  const flow = parseOptionalJsonRecord(row.flow_json, 'flow') as JobFlow | undefined
  return {
    jobId: row.job_id,
    projectId: row.project_id,
    agentId: row.agent_id,
    scopeRef: row.scope_ref,
    laneRef: row.lane_ref,
    schedule: parseJsonRecord(row.schedule_json, 'schedule') as JobSchedule,
    input: parseJsonRecord(row.input_json, 'input'),
    ...(flow !== undefined ? { flow } : {}),
    disabled: row.disabled !== 0,
    ...(row.last_fire_at !== null ? { lastFireAt: row.last_fire_at } : {}),
    ...(row.next_fire_at !== null ? { nextFireAt: row.next_fire_at } : {}),
    actor: rowToActor(row),
    actorStamp: row.actor_stamp,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toJobRunRecord(row: JobRunRow): JobRunRecord {
  return {
    jobRunId: row.job_run_id,
    jobId: row.job_id,
    triggeredAt: row.triggered_at,
    triggeredBy: row.triggered_by,
    status: row.status,
    ...(row.input_attempt_id !== null ? { inputAttemptId: row.input_attempt_id } : {}),
    ...(row.run_id !== null ? { runId: row.run_id } : {}),
    ...(row.error_code !== null ? { errorCode: row.error_code } : {}),
    ...(row.error_message !== null ? { errorMessage: row.error_message } : {}),
    ...(row.lease_owner !== null ? { leaseOwner: row.lease_owner } : {}),
    ...(row.lease_expires_at !== null ? { leaseExpiresAt: row.lease_expires_at } : {}),
    ...(row.claimed_at !== null ? { claimedAt: row.claimed_at } : {}),
    ...(row.dispatched_at !== null ? { dispatchedAt: row.dispatched_at } : {}),
    ...(row.completed_at !== null ? { completedAt: row.completed_at } : {}),
    actor: rowToActor(row),
    actorStamp: row.actor_stamp,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toJobStepRunRecord(row: JobStepRunRow): JobStepRunRecord {
  const result = parseOptionalJsonRecord(row.result_json, 'result')
  return {
    jobRunId: row.job_run_id,
    stepId: row.step_id,
    phase: row.phase,
    status: row.status,
    attempt: row.attempt,
    ...(row.input_attempt_id !== null ? { inputAttemptId: row.input_attempt_id } : {}),
    ...(row.run_id !== null ? { runId: row.run_id } : {}),
    ...(row.result_block !== null ? { resultBlock: row.result_block } : {}),
    ...(result !== undefined ? { result } : {}),
    ...(row.error_code !== null && row.error_message !== null
      ? { error: { code: row.error_code, message: row.error_message } }
      : {}),
    ...(row.started_at !== null ? { startedAt: row.started_at } : {}),
    ...(row.completed_at !== null ? { completedAt: row.completed_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function requireJobRow(sqlite: SqliteDatabase, jobId: string): JobRow {
  const row = sqlite
    .prepare('SELECT * FROM jobs WHERE job_id = ? AND archived_at IS NULL')
    .get(jobId) as JobRow | undefined
  if (row === undefined) {
    throw new Error(`job not found: ${jobId}`)
  }

  return row
}

function getJobRow(sqlite: SqliteDatabase, jobId: string): JobRow | undefined {
  return sqlite.prepare('SELECT * FROM jobs WHERE job_id = ? AND archived_at IS NULL').get(jobId) as
    | JobRow
    | undefined
}

function getJobRunRow(sqlite: SqliteDatabase, jobRunId: string): JobRunRow | undefined {
  return sqlite.prepare('SELECT * FROM job_runs WHERE job_run_id = ?').get(jobRunId) as
    | JobRunRow
    | undefined
}

function getJobStepRunRow(
  sqlite: SqliteDatabase,
  jobRunId: string,
  phase: JobStepRunPhase,
  stepId: string,
  attempt: number
): JobStepRunRow | undefined {
  return sqlite
    .prepare(
      `
        SELECT *
        FROM job_step_runs
        WHERE job_run_id = ? AND phase = ? AND step_id = ? AND attempt = ?
      `
    )
    .get(jobRunId, phase, stepId, attempt) as JobStepRunRow | undefined
}

function getScheduleWindowValue(
  schedule: JobSchedule,
  field: 'windowStart' | 'windowEnd'
): string | null {
  const value = schedule[field]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function requireSchedule(schedule: JobSchedule): JobSchedule {
  if (!isValidCron(schedule.cron)) {
    throw new Error(`invalid cron schedule: ${schedule.cron}`)
  }

  return schedule
}

function createNextFireAt(input: {
  schedule: JobSchedule
  disabled: boolean
  anchor: string
}): string | null {
  if (input.disabled) {
    return null
  }

  return nextFireAfter(input.schedule.cron, input.anchor)
}

export function listAppliedJobsStoreMigrations(sqlite: SqliteDatabase): string[] {
  ensureMigrationTable(sqlite)
  return (
    sqlite
      .prepare('SELECT id FROM acp_jobs_store_migrations ORDER BY id ASC')
      .all() as MigrationRow[]
  ).map((row) => row.id)
}

export function runJobsStoreMigrations(sqlite: SqliteDatabase): void {
  ensureMigrationTable(sqlite)
  const applied = new Set(listAppliedJobsStoreMigrations(sqlite))

  sqlite.transaction((pending: readonly JobsStoreMigration[]) => {
    for (const migration of pending) {
      if (applied.has(migration.id)) {
        continue
      }

      if (migration.sql.trim().length > 0) {
        sqlite.exec(migration.sql)
      }
      sqlite
        .prepare('INSERT INTO acp_jobs_store_migrations (id, applied_at) VALUES (?, ?)')
        .run(migration.id, new Date().toISOString())
    }
  })(jobsStoreMigrations)
}

export function openSqliteJobsStore(options: OpenSqliteJobsStoreOptions): JobsStore {
  const sqlite = createSqliteDatabase(options.dbPath)
  runJobsStoreMigrations(sqlite)

  const createJob = (input: CreateJobInput): { job: JobRecord } => {
    const now = toIsoString(input.createdAt)
    const actor = resolveActor(input.actor)
    const schedule = requireSchedule(input.schedule)
    const disabled = input.disabled ?? false
    const nextFireAt = createNextFireAt({ schedule, disabled, anchor: now })
    const jobId = input.jobId ?? `job_${randomUUID().replace(/-/g, '').slice(0, 12)}`

    sqlite
      .prepare(
        `
          INSERT INTO jobs (
            job_id,
            project_id,
            agent_id,
            scope_ref,
            lane_ref,
            schedule_cron,
            schedule_window_start,
            schedule_window_end,
            schedule_json,
            input_json,
            flow_json,
            disabled,
            last_fire_at,
            next_fire_at,
            actor_kind,
            actor_id,
            actor_display_name,
            actor_stamp,
            created_at,
            updated_at,
            archived_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
        `
      )
      .run(
        jobId,
        input.projectId,
        input.agentId,
        input.scopeRef,
        input.laneRef ?? 'main',
        schedule.cron,
        getScheduleWindowValue(schedule, 'windowStart'),
        getScheduleWindowValue(schedule, 'windowEnd'),
        JSON.stringify(schedule),
        JSON.stringify(input.input),
        input.flow !== undefined ? JSON.stringify(input.flow) : null,
        disabled ? 1 : 0,
        null,
        nextFireAt,
        actor.kind,
        actor.id,
        actor.displayName ?? null,
        input.actorStamp ?? actorToStamp(actor),
        now,
        now
      )

    return { job: toJobRecord(requireJobRow(sqlite, jobId)) }
  }

  const listJobs = (input?: ListJobsInput | undefined): { jobs: JobRecord[] } => {
    const rows =
      input?.projectId !== undefined
        ? (
            sqlite
              .prepare(
                `
                SELECT *
                FROM jobs
                WHERE archived_at IS NULL AND project_id = ?
                ORDER BY created_at DESC, job_id DESC
              `
              )
              .all(input.projectId) as JobRow[]
          ).map((row) => toJobRecord(row))
        : (
            sqlite
              .prepare(
                `
                SELECT *
                FROM jobs
                WHERE archived_at IS NULL
                ORDER BY created_at DESC, job_id DESC
              `
              )
              .all() as JobRow[]
          ).map((row) => toJobRecord(row))

    return { jobs: rows }
  }

  const getJob = (jobId: string): { job: JobRecord | undefined } => {
    const row = getJobRow(sqlite, jobId)
    return { job: row === undefined ? undefined : toJobRecord(row) }
  }

  const updateJob = (jobId: string, patch: UpdateJobInput): { job: JobRecord } => {
    const existing = requireJobRow(sqlite, jobId)
    const existingJob = toJobRecord(existing)
    const schedule =
      patch.schedule !== undefined ? requireSchedule(patch.schedule) : existingJob.schedule
    const disabled = patch.disabled ?? existingJob.disabled
    const flow = patch.flow ?? existingJob.flow
    const now = new Date().toISOString()
    const nextFireAt =
      patch.schedule !== undefined || patch.disabled !== undefined
        ? createNextFireAt({ schedule, disabled, anchor: now })
        : existing.next_fire_at

    sqlite
      .prepare(
        `
          UPDATE jobs
          SET schedule_cron = ?,
              schedule_window_start = ?,
              schedule_window_end = ?,
              schedule_json = ?,
              input_json = ?,
              flow_json = ?,
              disabled = ?,
              next_fire_at = ?,
              actor_kind = ?,
              actor_id = ?,
              actor_display_name = ?,
              actor_stamp = ?,
              updated_at = ?
          WHERE job_id = ? AND archived_at IS NULL
        `
      )
      .run(
        schedule.cron,
        getScheduleWindowValue(schedule, 'windowStart'),
        getScheduleWindowValue(schedule, 'windowEnd'),
        JSON.stringify(schedule),
        JSON.stringify(patch.input ?? existingJob.input),
        flow !== undefined ? JSON.stringify(flow) : null,
        disabled ? 1 : 0,
        nextFireAt,
        patch.actor?.kind ?? existing.actor_kind,
        patch.actor?.id ?? existing.actor_id,
        patch.actor?.displayName ?? existing.actor_display_name,
        patch.actorStamp ??
          (patch.actor !== undefined ? actorToStamp(patch.actor) : existing.actor_stamp),
        now,
        jobId
      )

    return { job: toJobRecord(requireJobRow(sqlite, jobId)) }
  }

  const archiveJob = (jobId: string): void => {
    const now = new Date().toISOString()
    sqlite
      .prepare(
        'UPDATE jobs SET archived_at = ?, updated_at = ? WHERE job_id = ? AND archived_at IS NULL'
      )
      .run(now, now, jobId)
  }

  const appendJobRun = (input: AppendJobRunInput): { jobRun: JobRunRecord } => {
    const jobRunId = input.jobRunId ?? `jrun_${randomUUID().replace(/-/g, '').slice(0, 12)}`
    const actor = resolveActor(input.actor)
    const now = new Date().toISOString()
    sqlite
      .prepare(
        `
          INSERT INTO job_runs (
            job_run_id,
            job_id,
            triggered_at,
            triggered_by,
            status,
            input_attempt_id,
            run_id,
            error_code,
            error_message,
            lease_owner,
            lease_expires_at,
            claimed_at,
            dispatched_at,
            completed_at,
            actor_kind,
            actor_id,
            actor_display_name,
            actor_stamp,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        jobRunId,
        input.jobId,
        input.triggeredAt,
        input.triggeredBy,
        input.status,
        input.inputAttemptId ?? null,
        input.runId ?? null,
        input.errorCode ?? null,
        input.errorMessage ?? null,
        input.leaseOwner ?? null,
        input.leaseExpiresAt ?? null,
        input.claimedAt ?? null,
        input.dispatchedAt ?? null,
        input.completedAt ?? null,
        actor.kind,
        actor.id,
        actor.displayName ?? null,
        input.actorStamp ?? actorToStamp(actor),
        now,
        now
      )

    const row = getJobRunRow(sqlite, jobRunId)
    if (row === undefined) {
      throw new Error(`job run not found after insert: ${jobRunId}`)
    }

    return { jobRun: toJobRunRecord(row) }
  }

  const listJobRuns = (jobId: string): { jobRuns: JobRunRecord[] } => ({
    jobRuns: (
      sqlite
        .prepare(
          'SELECT * FROM job_runs WHERE job_id = ? ORDER BY triggered_at DESC, job_run_id DESC'
        )
        .all(jobId) as JobRunRow[]
    ).map((row) => toJobRunRecord(row)),
  })

  const getJobRun = (jobRunId: string): { jobRun: JobRunRecord | undefined } => {
    const row = getJobRunRow(sqlite, jobRunId)
    return { jobRun: row === undefined ? undefined : toJobRunRecord(row) }
  }

  const updateJobRun = (jobRunId: string, patch: UpdateJobRunInput): { jobRun: JobRunRecord } => {
    const existing = getJobRunRow(sqlite, jobRunId)
    if (existing === undefined) {
      throw new Error(`job run not found: ${jobRunId}`)
    }

    const nextLeaseOwner = 'leaseOwner' in patch ? (patch.leaseOwner ?? null) : existing.lease_owner
    const nextLeaseExpiresAt =
      'leaseExpiresAt' in patch ? (patch.leaseExpiresAt ?? null) : existing.lease_expires_at
    const nextClaimedAt = patch.claimedAt ?? existing.claimed_at
    const nextDispatchedAt = patch.dispatchedAt ?? existing.dispatched_at
    const nextCompletedAt = patch.completedAt ?? existing.completed_at
    const now = new Date().toISOString()

    sqlite
      .prepare(
        `
          UPDATE job_runs
          SET status = ?,
              input_attempt_id = ?,
              run_id = ?,
              error_code = ?,
              error_message = ?,
              lease_owner = ?,
              lease_expires_at = ?,
              claimed_at = ?,
              dispatched_at = ?,
              completed_at = ?,
              actor_kind = ?,
              actor_id = ?,
              actor_display_name = ?,
              actor_stamp = ?,
              updated_at = ?
          WHERE job_run_id = ?
        `
      )
      .run(
        patch.status ?? existing.status,
        patch.inputAttemptId ?? existing.input_attempt_id,
        patch.runId ?? existing.run_id,
        patch.errorCode ?? existing.error_code,
        patch.errorMessage ?? existing.error_message,
        nextLeaseOwner,
        nextLeaseExpiresAt,
        nextClaimedAt,
        nextDispatchedAt,
        nextCompletedAt,
        patch.actor?.kind ?? existing.actor_kind,
        patch.actor?.id ?? existing.actor_id,
        patch.actor?.displayName ?? existing.actor_display_name,
        patch.actorStamp ??
          (patch.actor !== undefined ? actorToStamp(patch.actor) : existing.actor_stamp),
        now,
        jobRunId
      )

    const row = getJobRunRow(sqlite, jobRunId)
    if (row === undefined) {
      throw new Error(`job run not found after update: ${jobRunId}`)
    }

    return { jobRun: toJobRunRecord(row) }
  }

  const insertJobStepRuns = (
    jobRunId: string,
    phase: JobStepRunPhase,
    steps: readonly InsertJobStepRunInput[]
  ): { jobStepRuns: JobStepRunRecord[] } => {
    const baseTime = Date.now()
    sqlite.transaction(() => {
      steps.forEach((step, index) => {
        const now = new Date(baseTime + index).toISOString()
        const error = step.error
        sqlite
          .prepare(
            `
              INSERT INTO job_step_runs (
                job_run_id,
                phase,
                step_id,
                status,
                attempt,
                input_attempt_id,
                run_id,
                result_block,
                result_json,
                error_code,
                error_message,
                started_at,
                completed_at,
                created_at,
                updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `
          )
          .run(
            jobRunId,
            phase,
            step.stepId,
            step.status ?? 'pending',
            step.attempt ?? 1,
            step.inputAttemptId ?? null,
            step.runId ?? null,
            step.resultBlock ?? null,
            step.result !== undefined ? JSON.stringify(step.result) : null,
            error?.code ?? null,
            error?.message ?? null,
            step.startedAt ?? null,
            step.completedAt ?? null,
            now,
            now
          )
      })
    })()

    return {
      jobStepRuns: steps.map((step) => {
        const row = getJobStepRunRow(sqlite, jobRunId, phase, step.stepId, step.attempt ?? 1)
        if (row === undefined) {
          throw new Error(
            `job step run not found after insert: ${jobRunId}/${phase}/${step.stepId}`
          )
        }
        return toJobStepRunRecord(row)
      }),
    }
  }

  const updateJobStepRun = (
    jobRunId: string,
    phase: JobStepRunPhase,
    stepId: string,
    attempt: number,
    patch: UpdateJobStepRunInput
  ): { jobStepRun: JobStepRunRecord } => {
    const existing = getJobStepRunRow(sqlite, jobRunId, phase, stepId, attempt)
    if (existing === undefined) {
      throw new Error(`job step run not found: ${jobRunId}/${phase}/${stepId}/${attempt}`)
    }

    const nextInputAttemptId =
      'inputAttemptId' in patch ? (patch.inputAttemptId ?? null) : existing.input_attempt_id
    const nextRunId = 'runId' in patch ? (patch.runId ?? null) : existing.run_id
    const nextResultBlock =
      'resultBlock' in patch ? (patch.resultBlock ?? null) : existing.result_block
    const nextResultJson =
      'result' in patch
        ? patch.result === null || patch.result === undefined
          ? null
          : JSON.stringify(patch.result)
        : existing.result_json
    const nextErrorCode = 'error' in patch ? (patch.error?.code ?? null) : existing.error_code
    const nextErrorMessage =
      'error' in patch ? (patch.error?.message ?? null) : existing.error_message
    const nextStartedAt = 'startedAt' in patch ? (patch.startedAt ?? null) : existing.started_at
    const nextCompletedAt =
      'completedAt' in patch ? (patch.completedAt ?? null) : existing.completed_at
    const now = new Date().toISOString()

    sqlite
      .prepare(
        `
          UPDATE job_step_runs
          SET status = ?,
              input_attempt_id = ?,
              run_id = ?,
              result_block = ?,
              result_json = ?,
              error_code = ?,
              error_message = ?,
              started_at = ?,
              completed_at = ?,
              updated_at = ?
          WHERE job_run_id = ? AND phase = ? AND step_id = ? AND attempt = ?
        `
      )
      .run(
        patch.status ?? existing.status,
        nextInputAttemptId,
        nextRunId,
        nextResultBlock,
        nextResultJson,
        nextErrorCode,
        nextErrorMessage,
        nextStartedAt,
        nextCompletedAt,
        now,
        jobRunId,
        phase,
        stepId,
        attempt
      )

    const row = getJobStepRunRow(sqlite, jobRunId, phase, stepId, attempt)
    if (row === undefined) {
      throw new Error(`job step run not found after update: ${jobRunId}/${phase}/${stepId}`)
    }

    return { jobStepRun: toJobStepRunRecord(row) }
  }

  const listJobStepRuns = (jobRunId: string): { jobStepRuns: JobStepRunRecord[] } => ({
    jobStepRuns: (
      sqlite
        .prepare(
          `
            SELECT *
            FROM job_step_runs
            WHERE job_run_id = ?
            ORDER BY CASE phase WHEN 'sequence' THEN 0 ELSE 1 END ASC, created_at ASC, step_id ASC
          `
        )
        .all(jobRunId) as JobStepRunRow[]
    ).map((row) => toJobStepRunRecord(row)),
  })

  const getJobStepRun = (
    jobRunId: string,
    phase: JobStepRunPhase,
    stepId: string,
    attempt: number
  ): { jobStepRun: JobStepRunRecord | undefined } => {
    const row = getJobStepRunRow(sqlite, jobRunId, phase, stepId, attempt)
    return { jobStepRun: row === undefined ? undefined : toJobStepRunRecord(row) }
  }

  const claimDueJobRuns = (input: ClaimDueJobRunsInput): { jobRuns: JobRunRecord[] } => {
    const claimed = sqlite.transaction(() => {
      const candidates = sqlite
        .prepare(
          `
            SELECT job_run_id
            FROM job_runs
            WHERE triggered_at <= ?
              AND (
                status = 'pending'
                OR (status = 'claimed' AND (lease_expires_at IS NULL OR lease_expires_at <= ?))
              )
            ORDER BY triggered_at ASC, job_run_id ASC
            LIMIT ?
          `
        )
        .all(input.now, input.now, input.limit) as Array<{ job_run_id: string }>

      const results: JobRunRecord[] = []
      for (const candidate of candidates) {
        const changed = sqlite
          .prepare(
            `
              UPDATE job_runs
              SET status = 'claimed',
                  lease_owner = ?,
                  lease_expires_at = ?,
                  claimed_at = ?,
                  updated_at = ?
              WHERE job_run_id = ?
                AND triggered_at <= ?
                AND (
                  status = 'pending'
                  OR (status = 'claimed' AND (lease_expires_at IS NULL OR lease_expires_at <= ?))
                )
            `
          )
          .run(
            input.leaseOwner,
            input.leaseExpiresAt,
            input.now,
            input.now,
            candidate.job_run_id,
            input.now,
            input.now
          )

        if (changed.changes === 0) {
          continue
        }

        const row = getJobRunRow(sqlite, candidate.job_run_id)
        if (row !== undefined) {
          results.push(toJobRunRecord(row))
        }
      }

      return results
    })()

    return { jobRuns: claimed }
  }

  const createJobRun = (
    jobId: string,
    input: Omit<AppendJobRunInput, 'jobId'>
  ): { job: JobRecord; jobRun: JobRunRecord } => {
    const job = toJobRecord(requireJobRow(sqlite, jobId))
    const jobRun = appendJobRun({ ...input, jobId }).jobRun
    return { job, jobRun }
  }

  const listInflightFlowJobRuns = (input: { limit?: number | undefined } = {}): ClaimedDueJob[] => {
    const limit = input.limit ?? 100
    const rows = sqlite
      .prepare(
        `
          SELECT jr.*
          FROM job_runs jr
          JOIN jobs j ON j.job_id = jr.job_id
          WHERE jr.status IN ('claimed', 'dispatched')
            AND j.archived_at IS NULL
            AND j.flow_json IS NOT NULL
          ORDER BY jr.triggered_at ASC, jr.job_run_id ASC
          LIMIT ?
        `
      )
      .all(limit) as JobRunRow[]

    const results: ClaimedDueJob[] = []
    for (const row of rows) {
      const job = toJobRecord(requireJobRow(sqlite, row.job_id))
      results.push({ job, jobRun: toJobRunRecord(row) })
    }
    return results
  }

  const claimDueJobs = (input: ClaimDueJobsInput): ClaimedDueJob[] => {
    const now = input.now
    const limit = input.limit ?? 100

    return sqlite.transaction(() => {
      const dueJobs = sqlite
        .prepare(
          `
            SELECT *
            FROM jobs
            WHERE archived_at IS NULL
              AND disabled = 0
              AND (next_fire_at IS NULL OR next_fire_at <= ?)
            ORDER BY COALESCE(next_fire_at, '') ASC, job_id ASC
            LIMIT ?
          `
        )
        .all(now, limit) as JobRow[]

      const claimed: ClaimedDueJob[] = []
      for (const row of dueJobs) {
        const dueAt =
          row.next_fire_at ?? nextFireAfter(row.schedule_cron, row.last_fire_at ?? row.created_at)
        if (dueAt === null || dueAt > now) {
          continue
        }

        const nextAfterNow = nextFireAfter(row.schedule_cron, now)
        const triggeredBy: JobRunTrigger = dueAt === now ? 'schedule' : 'catch-up'
        const updateResult = sqlite
          .prepare(
            `
              UPDATE jobs
              SET last_fire_at = ?,
                  next_fire_at = ?,
                  updated_at = ?
              WHERE job_id = ?
                AND archived_at IS NULL
                AND disabled = 0
                AND ${row.next_fire_at === null ? 'next_fire_at IS NULL' : 'next_fire_at = ?'}
            `
          )
          .run(
            now,
            nextAfterNow,
            now,
            row.job_id,
            ...(row.next_fire_at === null ? [] : [row.next_fire_at])
          )

        if (updateResult.changes === 0) {
          continue
        }

        const jobRun = appendJobRun({
          jobId: row.job_id,
          triggeredAt: now,
          triggeredBy,
          status: 'claimed',
          claimedAt: now,
          actor: input.actor ?? { kind: 'system', id: 'scheduler' },
          actorStamp:
            input.actorStamp ?? actorToStamp(input.actor ?? { kind: 'system', id: 'scheduler' }),
        }).jobRun

        const updatedRow = requireJobRow(sqlite, row.job_id)
        claimed.push({
          job: toJobRecord(updatedRow),
          jobRun,
        })
      }

      return claimed
    })()
  }

  const store = {
    sqlite,
    migrations: {
      applied: listAppliedJobsStoreMigrations(sqlite),
    },
    jobs: {
      create: createJob,
      list: listJobs,
      get: getJob,
      update: updateJob,
      archive: archiveJob,
    },
    jobRuns: {
      append: appendJobRun,
      listByJob: listJobRuns,
      get: getJobRun,
      update: updateJobRun,
      claimDueRuns: claimDueJobRuns,
    },
    jobStepRuns: {
      insertMany: insertJobStepRuns,
      updateStep: updateJobStepRun,
      listByJobRun: listJobStepRuns,
      getById: getJobStepRun,
    },
    createJob,
    listJobs,
    getJob,
    updateJob,
    archiveJob,
    appendJobRun,
    listJobRuns,
    getJobRun,
    updateJobRun,
    claimDueJobRuns,
    insertJobStepRuns,
    updateJobStepRun,
    listJobStepRuns,
    getJobStepRun,
    createJobRun,
    claimDueJobs,
    listInflightFlowJobRuns,
    runInTransaction<T>(fn: (innerStore: JobsStore) => T): T {
      const transaction = sqlite.transaction(() => fn(store as JobsStore))
      return transaction()
    },
    close(): void {
      sqlite.close()
    },
  } satisfies JobsStore

  return store
}

export function createInMemoryJobsStore(): JobsStore {
  return openSqliteJobsStore({ dbPath: ':memory:' })
}
