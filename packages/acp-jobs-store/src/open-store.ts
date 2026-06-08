import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import type { Actor, JobFlow, JobStepRunPhase, JobStepRunStatus, JobTrigger } from 'acp-core'
import { validateJobTrigger } from 'acp-core'

import { isValidCron, nextFireAfter } from './cron.js'
import Database, { type SqliteDatabase } from './sqlite.js'

/** Default page size for inflight/due claim queries. */
const DEFAULT_CLAIM_LIMIT = 100
/** Default page size for pending inbox-event claim queries. */
const DEFAULT_INBOX_CLAIM_LIMIT = 50

/** Generate a prefixed, hyphen-stripped, 12-char id (e.g. `job_ab12cd34ef56`). */
function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`
}

type MigrationRow = {
  id: string
}

type JobRow = {
  job_id: string
  slug: string
  description: string | null
  project_id: string
  agent_id: string
  scope_ref: string
  lane_ref: string
  trigger_kind: string
  trigger_json: string
  schedule_cron: string | null
  schedule_window_start: string | null
  schedule_window_end: string | null
  schedule_json: string | null
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
  resolved_scope_ref: string | null
  resolved_lane_ref: string | null
  resolved_input_json: string | null
  source_json: string | null
  actor_kind: Actor['kind'] | null
  actor_id: string | null
  actor_display_name: string | null
  actor_stamp: string
  created_at: string
  updated_at: string
}

type InboxEventRow = {
  event_id: string
  event_seq: number
  source: string
  event: string
  occurred_at: string | null
  payload_json: string
  status: InboxEventStatus
  lease_owner: string | null
  lease_expires_at: string | null
  attempts: number
  last_error: string | null
  received_at: string
  processed_at: string | null
  created_at: string
  updated_at: string
}

type EventJobMatchRow = {
  source_event_id: string
  job_id: string
  event_seq: number
  outcome: EventJobOutcome
  reason: EventJobSkipReason | null
  job_run_id: string | null
  target_task_id: string | null
  created_at: string
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

export type JobRunTrigger = 'schedule' | 'manual' | 'catch-up' | 'webhook'

export type JobRunStatus = 'pending' | 'claimed' | 'dispatched' | 'succeeded' | 'failed' | 'skipped'

export type InboxEventStatus = 'pending' | 'leased' | 'processed' | 'failed'

export type EventJobOutcome = 'minted' | 'skipped'

export type EventJobSkipReason =
  | 'agent_origin_blocked'
  | 'cooldown'
  | 'template_error'
  | 'match_false'

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
  slug: string
  description?: string | undefined
  projectId: string
  agentId: string
  scopeRef: string
  laneRef: string
  trigger: JobTrigger
  /** Present only for schedule-kind triggers; undefined for event triggers. */
  schedule?: JobSchedule | undefined
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

export type InboxEventRecord = {
  eventId: string
  eventSeq: number
  source: string
  event: string
  occurredAt?: string | undefined
  payload: Readonly<Record<string, unknown>>
  status: InboxEventStatus
  leaseOwner?: string | undefined
  leaseExpiresAt?: string | undefined
  attempts: number
  lastError?: string | undefined
  receivedAt: string
  processedAt?: string | undefined
  createdAt: string
  updatedAt: string
}

export type EventJobMatchRecord = {
  sourceEventId: string
  jobId: string
  eventSeq: number
  outcome: EventJobOutcome
  reason?: EventJobSkipReason | undefined
  jobRunId?: string | undefined
  targetTaskId?: string | undefined
  createdAt: string
}

export const JOB_SLUG_REGEX = /^[a-z0-9][a-z0-9._-]{0,79}$/

export function isValidJobSlug(value: string): boolean {
  return JOB_SLUG_REGEX.test(value)
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
  /** Resolved action snapshot — set for event (webhook) runs; the dispatch tail
   * consumes these instead of the live templated job fields. */
  resolvedScopeRef?: string | undefined
  resolvedLaneRef?: string | undefined
  resolvedInput?: Readonly<Record<string, unknown>> | undefined
  /** Source provenance, e.g. { kind:'webhook', source:'wrkq', eventId, eventSeq }. */
  source?: Readonly<Record<string, unknown>> | undefined
  actor: Actor
  actorStamp?: string | undefined
  createdAt: string
  updatedAt: string
}

export type CreateJobInput = {
  jobId?: string | undefined
  slug?: string | undefined
  description?: string | undefined
  projectId: string
  agentId: string
  scopeRef: string
  laneRef?: string | undefined
  /** Canonical trigger. When omitted, `schedule` is promoted to a schedule trigger. */
  trigger?: JobTrigger | undefined
  schedule?: JobSchedule | undefined
  input: JobInputTemplate
  flow?: JobFlow | undefined
  disabled?: boolean | undefined
  actor?: Actor | undefined
  actorStamp?: string | undefined
  createdAt?: string | undefined
}

export type UpdateJobInput = {
  slug?: string | undefined
  description?: string | null | undefined
  trigger?: JobTrigger | undefined
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
  resolvedScopeRef?: string | undefined
  resolvedLaneRef?: string | undefined
  resolvedInput?: Readonly<Record<string, unknown>> | undefined
  source?: Readonly<Record<string, unknown>> | undefined
  actor?: Actor | undefined
  actorStamp?: string | undefined
}

export type InsertInboxEventInput = {
  eventId: string
  eventSeq: number
  source?: string | undefined
  event: string
  occurredAt?: string | undefined
  payload: Readonly<Record<string, unknown>>
  receivedAt?: string | undefined
}

export type ClaimInboxEventsInput = {
  now: string
  limit?: number | undefined
  leaseOwner: string
  leaseExpiresAt: string
}

export type RecordEventJobSkipInput = {
  sourceEventId: string
  jobId: string
  eventSeq: number
  reason: EventJobSkipReason
  targetTaskId?: string | undefined
  now?: string | undefined
}

export type MintEventJobRunInput = {
  sourceEventId: string
  eventSeq: number
  jobId: string
  resolvedScopeRef: string
  resolvedLaneRef: string
  resolvedInput: Readonly<Record<string, unknown>>
  source: Readonly<Record<string, unknown>>
  targetTaskId?: string | undefined
  triggeredAt?: string | undefined
  actor?: Actor | undefined
  actorStamp?: string | undefined
}

export type ListEventJobMatchesInput = {
  sourceEventId?: string | undefined
  jobId?: string | undefined
  limit?: number | undefined
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
  {
    id: '004_job_slug_description',
    sql: `
      ALTER TABLE jobs ADD COLUMN slug TEXT;
      ALTER TABLE jobs ADD COLUMN description TEXT;
      UPDATE jobs SET slug = job_id WHERE slug IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS jobs_project_slug_idx
        ON jobs (project_id, slug)
        WHERE archived_at IS NULL;
    `,
  },
  {
    id: '005_job_trigger_union_and_event_inbox',
    sql: `
      -- 1. Add the trigger union columns and backfill existing rows as schedule
      --    triggers (the only trigger that existed before this migration).
      ALTER TABLE jobs ADD COLUMN trigger_kind TEXT;
      ALTER TABLE jobs ADD COLUMN trigger_json TEXT;
      UPDATE jobs
         SET trigger_kind = 'schedule',
             trigger_json = json_set(COALESCE(NULLIF(schedule_json, ''), '{}'), '$.kind', 'schedule')
       WHERE trigger_kind IS NULL;

      -- 2. Rebuild jobs to drop NOT NULL from schedule_cron/schedule_json (which
      --    are now schedule-only denormalized indexes) and make trigger_kind /
      --    trigger_json NOT NULL. No other table holds a FK to jobs.
      CREATE TABLE jobs_new (
        job_id TEXT PRIMARY KEY,
        slug TEXT,
        description TEXT,
        project_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        scope_ref TEXT NOT NULL,
        lane_ref TEXT NOT NULL,
        trigger_kind TEXT NOT NULL,
        trigger_json TEXT NOT NULL,
        schedule_cron TEXT,
        schedule_window_start TEXT,
        schedule_window_end TEXT,
        schedule_json TEXT,
        input_json TEXT NOT NULL,
        flow_json TEXT,
        disabled INTEGER NOT NULL DEFAULT 0,
        last_fire_at TEXT,
        next_fire_at TEXT,
        actor_kind TEXT,
        actor_id TEXT,
        actor_display_name TEXT,
        actor_stamp TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT
      );
      INSERT INTO jobs_new (
        job_id, slug, description, project_id, agent_id, scope_ref, lane_ref,
        trigger_kind, trigger_json, schedule_cron, schedule_window_start,
        schedule_window_end, schedule_json, input_json, flow_json, disabled,
        last_fire_at, next_fire_at, actor_kind, actor_id, actor_display_name,
        actor_stamp, created_at, updated_at, archived_at
      )
      SELECT
        job_id, slug, description, project_id, agent_id, scope_ref, lane_ref,
        trigger_kind, trigger_json, schedule_cron, schedule_window_start,
        schedule_window_end, schedule_json, input_json, flow_json, disabled,
        last_fire_at, next_fire_at, actor_kind, actor_id, actor_display_name,
        actor_stamp, created_at, updated_at, archived_at
      FROM jobs;
      DROP TABLE jobs;
      ALTER TABLE jobs_new RENAME TO jobs;

      CREATE INDEX IF NOT EXISTS jobs_project_id_idx ON jobs (project_id);
      CREATE INDEX IF NOT EXISTS jobs_next_fire_at_idx
        ON jobs (next_fire_at) WHERE archived_at IS NULL AND disabled = 0;
      CREATE UNIQUE INDEX IF NOT EXISTS jobs_project_slug_idx
        ON jobs (project_id, slug) WHERE archived_at IS NULL;
      CREATE INDEX IF NOT EXISTS jobs_trigger_kind_idx
        ON jobs (trigger_kind) WHERE archived_at IS NULL AND disabled = 0;

      -- 3. Resolved-action snapshot + source provenance on job_runs (event runs).
      ALTER TABLE job_runs ADD COLUMN resolved_scope_ref TEXT;
      ALTER TABLE job_runs ADD COLUMN resolved_lane_ref TEXT;
      ALTER TABLE job_runs ADD COLUMN resolved_input_json TEXT;
      ALTER TABLE job_runs ADD COLUMN source_json TEXT;

      -- 4. event_inbox: durable, idempotent receipt of webhook events with
      --    claim/retry semantics. One event -> 0..N JobRuns.
      CREATE TABLE IF NOT EXISTS event_inbox (
        event_id TEXT PRIMARY KEY,
        event_seq INTEGER NOT NULL,
        source TEXT NOT NULL DEFAULT 'wrkq',
        event TEXT NOT NULL,
        occurred_at TEXT,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        lease_owner TEXT,
        lease_expires_at TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        received_at TEXT NOT NULL,
        processed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS event_inbox_drain_idx ON event_inbox (status, event_seq);

      -- 5. event_job_matches: per-(event,job) outcome ledger. PK enforces mint
      --    idempotency (drain-retry safe) and doubles as the skip ledger.
      CREATE TABLE IF NOT EXISTS event_job_matches (
        source_event_id TEXT NOT NULL,
        job_id TEXT NOT NULL,
        event_seq INTEGER NOT NULL,
        outcome TEXT NOT NULL,
        reason TEXT,
        job_run_id TEXT,
        target_task_id TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (source_event_id, job_id)
      );
      CREATE INDEX IF NOT EXISTS event_job_matches_cooldown_idx
        ON event_job_matches (job_id, target_task_id, created_at)
        WHERE outcome = 'minted';
      CREATE INDEX IF NOT EXISTS event_job_matches_event_idx
        ON event_job_matches (source_event_id);
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
  readonly eventInbox: {
    insert(input: InsertInboxEventInput): { event: InboxEventRecord; inserted: boolean }
    get(eventId: string): { event: InboxEventRecord | undefined }
    claimPending(input: ClaimInboxEventsInput): InboxEventRecord[]
    markProcessed(eventId: string, now?: string | undefined): void
    markFailed(eventId: string, error: string, now?: string | undefined): void
  }
  insertInboxEvent(input: InsertInboxEventInput): { event: InboxEventRecord; inserted: boolean }
  getInboxEvent(eventId: string): { event: InboxEventRecord | undefined }
  claimPendingInboxEvents(input: ClaimInboxEventsInput): InboxEventRecord[]
  markInboxEventProcessed(eventId: string, now?: string | undefined): void
  markInboxEventFailed(eventId: string, error: string, now?: string | undefined): void
  listActiveEventJobs(): { jobs: JobRecord[] }
  getEventJobMatch(sourceEventId: string, jobId: string): { match: EventJobMatchRecord | undefined }
  recordEventJobSkip(input: RecordEventJobSkipInput): { recorded: boolean }
  hasRecentMint(jobId: string, targetTaskId: string, sinceIso: string): boolean
  mintEventJobRun(input: MintEventJobRunInput): { jobRun: JobRunRecord; minted: boolean }
  listEventJobMatches(input?: ListEventJobMatchesInput | undefined): {
    matches: EventJobMatchRecord[]
  }
  runInTransaction<T>(fn: (store: JobsStore) => T): T
  close(): void
}

function normalizeOptionalString(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
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

function parseTriggerJson(value: string): JobTrigger {
  const validation = validateJobTrigger(JSON.parse(value) as unknown)
  if (!validation.valid) {
    throw new Error(`stored trigger is invalid: ${validation.errors.join('; ')}`)
  }
  return validation.trigger
}

function toJobRecord(row: JobRow): JobRecord {
  const flow = parseOptionalJsonRecord(row.flow_json, 'flow') as JobFlow | undefined
  const trigger = parseTriggerJson(row.trigger_json)
  const schedule =
    row.schedule_json !== null
      ? (parseJsonRecord(row.schedule_json, 'schedule') as JobSchedule)
      : undefined
  return {
    jobId: row.job_id,
    slug: row.slug ?? row.job_id,
    ...(row.description !== null ? { description: row.description } : {}),
    projectId: row.project_id,
    agentId: row.agent_id,
    scopeRef: row.scope_ref,
    laneRef: row.lane_ref,
    trigger,
    ...(trigger.kind === 'schedule' && schedule !== undefined ? { schedule } : {}),
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

function toInboxEventRecord(row: InboxEventRow): InboxEventRecord {
  return {
    eventId: row.event_id,
    eventSeq: row.event_seq,
    source: row.source,
    event: row.event,
    ...(row.occurred_at !== null ? { occurredAt: row.occurred_at } : {}),
    payload: parseJsonRecord(row.payload_json, 'payload'),
    status: row.status,
    ...(row.lease_owner !== null ? { leaseOwner: row.lease_owner } : {}),
    ...(row.lease_expires_at !== null ? { leaseExpiresAt: row.lease_expires_at } : {}),
    attempts: row.attempts,
    ...(row.last_error !== null ? { lastError: row.last_error } : {}),
    receivedAt: row.received_at,
    ...(row.processed_at !== null ? { processedAt: row.processed_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toEventJobMatchRecord(row: EventJobMatchRow): EventJobMatchRecord {
  return {
    sourceEventId: row.source_event_id,
    jobId: row.job_id,
    eventSeq: row.event_seq,
    outcome: row.outcome,
    ...(row.reason !== null ? { reason: row.reason } : {}),
    ...(row.job_run_id !== null ? { jobRunId: row.job_run_id } : {}),
    ...(row.target_task_id !== null ? { targetTaskId: row.target_task_id } : {}),
    createdAt: row.created_at,
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
    ...(row.resolved_scope_ref !== null ? { resolvedScopeRef: row.resolved_scope_ref } : {}),
    ...(row.resolved_lane_ref !== null ? { resolvedLaneRef: row.resolved_lane_ref } : {}),
    ...(row.resolved_input_json !== null
      ? { resolvedInput: parseJsonRecord(row.resolved_input_json, 'resolvedInput') }
      : {}),
    ...(row.source_json !== null
      ? { source: parseJsonRecord(row.source_json, 'source') }
      : {}),
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
    inputAttemptId: row.input_attempt_id ?? undefined,
    runId: row.run_id ?? undefined,
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

function scheduleFromTrigger(trigger: Extract<JobTrigger, { kind: 'schedule' }>): JobSchedule {
  return {
    cron: trigger.cron,
    ...(trigger.windowStart !== undefined ? { windowStart: trigger.windowStart } : {}),
    ...(trigger.windowEnd !== undefined ? { windowEnd: trigger.windowEnd } : {}),
    ...(trigger.windowMinutes !== undefined ? { windowMinutes: trigger.windowMinutes } : {}),
  }
}

/** Resolve the canonical trigger for a job, promoting a legacy `schedule` input. */
function resolveTrigger(input: {
  trigger?: JobTrigger | undefined
  schedule?: JobSchedule | undefined
}): JobTrigger {
  if (input.trigger !== undefined) {
    const validation = validateJobTrigger(input.trigger)
    if (!validation.valid) {
      throw new Error(`invalid trigger: ${validation.errors.join('; ')}`)
    }
    return validation.trigger
  }
  if (input.schedule !== undefined) {
    return {
      kind: 'schedule',
      cron: input.schedule.cron,
      ...(typeof input.schedule.windowStart === 'string'
        ? { windowStart: input.schedule.windowStart }
        : {}),
      ...(typeof input.schedule.windowEnd === 'string'
        ? { windowEnd: input.schedule.windowEnd }
        : {}),
      ...(typeof input.schedule.windowMinutes === 'number'
        ? { windowMinutes: input.schedule.windowMinutes }
        : {}),
    }
  }
  throw new Error('job requires a trigger or schedule')
}

type JobScheduleColumns = {
  scheduleCron: string | null
  windowStart: string | null
  windowEnd: string | null
  scheduleJson: string | null
  nextFireAt: string | null
}

/**
 * Derive the schedule-only denormalized columns + next_fire_at from a trigger.
 * Event triggers leave every schedule column null (next_fire_at is a
 * schedule-only readiness index, NOT generic trigger readiness).
 */
function scheduleColumnsForTrigger(input: {
  trigger: JobTrigger
  schedule?: JobSchedule | undefined
  disabled: boolean
  anchor: string
}): JobScheduleColumns {
  if (input.trigger.kind !== 'schedule') {
    return {
      scheduleCron: null,
      windowStart: null,
      windowEnd: null,
      scheduleJson: null,
      nextFireAt: null,
    }
  }
  const schedule = requireSchedule(input.schedule ?? scheduleFromTrigger(input.trigger))
  return {
    scheduleCron: schedule.cron,
    windowStart: getScheduleWindowValue(schedule, 'windowStart'),
    windowEnd: getScheduleWindowValue(schedule, 'windowEnd'),
    scheduleJson: JSON.stringify(schedule),
    nextFireAt: createNextFireAt({ schedule, disabled: input.disabled, anchor: input.anchor }),
  }
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
    const disabled = input.disabled ?? false
    const trigger = resolveTrigger(input)
    const columns = scheduleColumnsForTrigger({ trigger, schedule: input.schedule, disabled, anchor: now })
    const jobId = input.jobId ?? newId('job')
    const slug = input.slug ?? jobId
    if (!isValidJobSlug(slug)) {
      throw new Error(`invalid job slug: ${slug}`)
    }
    const description = normalizeOptionalString(input.description)

    sqlite
      .prepare(
        `
          INSERT INTO jobs (
            job_id,
            slug,
            description,
            project_id,
            agent_id,
            scope_ref,
            lane_ref,
            trigger_kind,
            trigger_json,
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
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
        `
      )
      .run(
        jobId,
        slug,
        description ?? null,
        input.projectId,
        input.agentId,
        input.scopeRef,
        input.laneRef ?? 'main',
        trigger.kind,
        JSON.stringify(trigger),
        columns.scheduleCron,
        columns.windowStart,
        columns.windowEnd,
        columns.scheduleJson,
        JSON.stringify(input.input),
        input.flow !== undefined ? JSON.stringify(input.flow) : null,
        disabled ? 1 : 0,
        null,
        columns.nextFireAt,
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
    const disabled = patch.disabled ?? existingJob.disabled
    const flow = patch.flow ?? existingJob.flow
    const slug = patch.slug ?? existingJob.slug
    if (patch.slug !== undefined && !isValidJobSlug(patch.slug)) {
      throw new Error(`invalid job slug: ${patch.slug}`)
    }
    const description =
      patch.description === null
        ? null
        : patch.description !== undefined
          ? (normalizeOptionalString(patch.description) ?? null)
          : (existing.description ?? null)
    const now = new Date().toISOString()

    const triggerChanged = patch.trigger !== undefined || patch.schedule !== undefined
    const trigger =
      patch.trigger !== undefined
        ? resolveTrigger({ trigger: patch.trigger })
        : patch.schedule !== undefined
          ? resolveTrigger({ schedule: patch.schedule })
          : existingJob.trigger
    const columns =
      triggerChanged || patch.disabled !== undefined
        ? scheduleColumnsForTrigger({
            trigger,
            schedule: patch.schedule ?? existingJob.schedule,
            disabled,
            anchor: now,
          })
        : {
            scheduleCron: existing.schedule_cron,
            windowStart: existing.schedule_window_start,
            windowEnd: existing.schedule_window_end,
            scheduleJson: existing.schedule_json,
            nextFireAt: existing.next_fire_at,
          }

    sqlite
      .prepare(
        `
          UPDATE jobs
          SET slug = ?,
              description = ?,
              trigger_kind = ?,
              trigger_json = ?,
              schedule_cron = ?,
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
        slug,
        description,
        trigger.kind,
        JSON.stringify(trigger),
        columns.scheduleCron,
        columns.windowStart,
        columns.windowEnd,
        columns.scheduleJson,
        JSON.stringify(patch.input ?? existingJob.input),
        flow !== undefined ? JSON.stringify(flow) : null,
        disabled ? 1 : 0,
        columns.nextFireAt,
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
    const jobRunId = input.jobRunId ?? newId('jrun')
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
            resolved_scope_ref,
            resolved_lane_ref,
            resolved_input_json,
            source_json,
            actor_kind,
            actor_id,
            actor_display_name,
            actor_stamp,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        input.resolvedScopeRef ?? null,
        input.resolvedLaneRef ?? null,
        input.resolvedInput !== undefined ? JSON.stringify(input.resolvedInput) : null,
        input.source !== undefined ? JSON.stringify(input.source) : null,
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
    const limit = input.limit ?? DEFAULT_CLAIM_LIMIT
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
    const limit = input.limit ?? DEFAULT_CLAIM_LIMIT

    return sqlite.transaction(() => {
      const dueJobs = sqlite
        .prepare(
          `
            SELECT *
            FROM jobs
            WHERE archived_at IS NULL
              AND disabled = 0
              AND trigger_kind = 'schedule'
              AND (next_fire_at IS NULL OR next_fire_at <= ?)
            ORDER BY COALESCE(next_fire_at, '') ASC, job_id ASC
            LIMIT ?
          `
        )
        .all(now, limit) as JobRow[]

      const claimed: ClaimedDueJob[] = []
      for (const row of dueJobs) {
        // The SELECT only returns schedule-kind rows with a non-null next_fire_at,
        // but a defensive guard keeps the cron read total.
        if (row.schedule_cron === null) {
          continue
        }
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

        const claimActor: Actor = input.actor ?? { kind: 'system', id: 'scheduler' }
        const jobRun = appendJobRun({
          jobId: row.job_id,
          triggeredAt: now,
          triggeredBy,
          status: 'claimed',
          claimedAt: now,
          actor: claimActor,
          actorStamp: input.actorStamp ?? actorToStamp(claimActor),
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

  // --- Webhook event-job primitives ---------------------------------------

  const getInboxEvent = (eventId: string): { event: InboxEventRecord | undefined } => {
    const row = sqlite.prepare('SELECT * FROM event_inbox WHERE event_id = ?').get(eventId) as
      | InboxEventRow
      | undefined
    return { event: row === undefined ? undefined : toInboxEventRecord(row) }
  }

  const insertInboxEvent = (
    input: InsertInboxEventInput
  ): { event: InboxEventRecord; inserted: boolean } => {
    const now = new Date().toISOString()
    const result = sqlite
      .prepare(
        `
          INSERT OR IGNORE INTO event_inbox (
            event_id, event_seq, source, event, occurred_at, payload_json,
            status, attempts, received_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
        `
      )
      .run(
        input.eventId,
        input.eventSeq,
        input.source ?? 'wrkq',
        input.event,
        input.occurredAt ?? null,
        JSON.stringify(input.payload),
        input.receivedAt ?? now,
        now,
        now
      )
    const event = getInboxEvent(input.eventId).event
    if (event === undefined) {
      throw new Error(`event inbox row not found after insert: ${input.eventId}`)
    }
    return { event, inserted: result.changes > 0 }
  }

  const claimPendingInboxEvents = (input: ClaimInboxEventsInput): InboxEventRecord[] => {
    const limit = input.limit ?? DEFAULT_INBOX_CLAIM_LIMIT
    return sqlite.transaction(() => {
      const candidates = sqlite
        .prepare(
          `
            SELECT event_id
            FROM event_inbox
            WHERE status = 'pending'
               OR (status = 'leased' AND (lease_expires_at IS NULL OR lease_expires_at <= ?))
            ORDER BY event_seq ASC
            LIMIT ?
          `
        )
        .all(input.now, limit) as Array<{ event_id: string }>

      const claimed: InboxEventRecord[] = []
      for (const candidate of candidates) {
        const changed = sqlite
          .prepare(
            `
              UPDATE event_inbox
              SET status = 'leased',
                  lease_owner = ?,
                  lease_expires_at = ?,
                  attempts = attempts + 1,
                  updated_at = ?
              WHERE event_id = ?
                AND (
                  status = 'pending'
                  OR (status = 'leased' AND (lease_expires_at IS NULL OR lease_expires_at <= ?))
                )
            `
          )
          .run(input.leaseOwner, input.leaseExpiresAt, input.now, candidate.event_id, input.now)
        if (changed.changes === 0) {
          continue
        }
        const event = getInboxEvent(candidate.event_id).event
        if (event !== undefined) {
          claimed.push(event)
        }
      }
      return claimed
    })()
  }

  const markInboxEventProcessed = (eventId: string, now?: string | undefined): void => {
    const ts = now ?? new Date().toISOString()
    sqlite
      .prepare(
        `
          UPDATE event_inbox
          SET status = 'processed', processed_at = ?, lease_owner = NULL,
              lease_expires_at = NULL, last_error = NULL, updated_at = ?
          WHERE event_id = ?
        `
      )
      .run(ts, ts, eventId)
  }

  const markInboxEventFailed = (eventId: string, error: string, now?: string | undefined): void => {
    const ts = now ?? new Date().toISOString()
    sqlite
      .prepare(
        `
          UPDATE event_inbox
          SET status = 'failed', last_error = ?, lease_owner = NULL,
              lease_expires_at = NULL, updated_at = ?
          WHERE event_id = ?
        `
      )
      .run(error, ts, eventId)
  }

  const listActiveEventJobs = (): { jobs: JobRecord[] } => ({
    jobs: (
      sqlite
        .prepare(
          `
            SELECT *
            FROM jobs
            WHERE archived_at IS NULL
              AND disabled = 0
              AND trigger_kind = 'event'
            ORDER BY created_at ASC, job_id ASC
          `
        )
        .all() as JobRow[]
    ).map((row) => toJobRecord(row)),
  })

  const getEventJobMatch = (
    sourceEventId: string,
    jobId: string
  ): { match: EventJobMatchRecord | undefined } => {
    const row = sqlite
      .prepare('SELECT * FROM event_job_matches WHERE source_event_id = ? AND job_id = ?')
      .get(sourceEventId, jobId) as EventJobMatchRow | undefined
    return { match: row === undefined ? undefined : toEventJobMatchRecord(row) }
  }

  const recordEventJobSkip = (input: RecordEventJobSkipInput): { recorded: boolean } => {
    const now = input.now ?? new Date().toISOString()
    const result = sqlite
      .prepare(
        `
          INSERT OR IGNORE INTO event_job_matches (
            source_event_id, job_id, event_seq, outcome, reason, job_run_id,
            target_task_id, created_at
          ) VALUES (?, ?, ?, 'skipped', ?, NULL, ?, ?)
        `
      )
      .run(
        input.sourceEventId,
        input.jobId,
        input.eventSeq,
        input.reason,
        input.targetTaskId ?? null,
        now
      )
    return { recorded: result.changes > 0 }
  }

  /**
   * Cooldown backstop: has this job already minted a run for this resolved
   * target task since `sinceIso`?
   */
  const hasRecentMint = (jobId: string, targetTaskId: string, sinceIso: string): boolean => {
    const row = sqlite
      .prepare(
        `
          SELECT 1
          FROM event_job_matches
          WHERE job_id = ? AND target_task_id = ? AND outcome = 'minted' AND created_at >= ?
          LIMIT 1
        `
      )
      .get(jobId, targetTaskId, sinceIso)
    return row !== undefined
  }

  /**
   * Idempotently mint a JobRun for a matched (event, job) pair. The mint and the
   * minted ledger row are written in one transaction; the (source_event_id,
   * job_id) PK makes drain-retry safe (no double-mint).
   */
  const mintEventJobRun = (
    input: MintEventJobRunInput
  ): { jobRun: JobRunRecord; minted: boolean } => {
    return sqlite.transaction(() => {
      const existing = getEventJobMatch(input.sourceEventId, input.jobId).match
      if (existing !== undefined) {
        if (existing.outcome === 'minted' && existing.jobRunId !== undefined) {
          const jobRun = getJobRun(existing.jobRunId).jobRun
          if (jobRun !== undefined) {
            return { jobRun, minted: false }
          }
        }
        throw new Error(
          `event-job pair already recorded as ${existing.outcome}: ${input.sourceEventId}/${input.jobId}`
        )
      }

      const now = input.triggeredAt ?? new Date().toISOString()
      const jobRun = appendJobRun({
        jobId: input.jobId,
        triggeredAt: now,
        triggeredBy: 'webhook',
        status: 'claimed',
        claimedAt: now,
        resolvedScopeRef: input.resolvedScopeRef,
        resolvedLaneRef: input.resolvedLaneRef,
        resolvedInput: input.resolvedInput,
        source: input.source,
        ...(input.actor !== undefined ? { actor: input.actor } : {}),
        ...(input.actorStamp !== undefined ? { actorStamp: input.actorStamp } : {}),
      }).jobRun

      sqlite
        .prepare(
          `
            INSERT INTO event_job_matches (
              source_event_id, job_id, event_seq, outcome, reason, job_run_id,
              target_task_id, created_at
            ) VALUES (?, ?, ?, 'minted', NULL, ?, ?, ?)
          `
        )
        .run(
          input.sourceEventId,
          input.jobId,
          input.eventSeq,
          jobRun.jobRunId,
          input.targetTaskId ?? null,
          now
        )

      return { jobRun, minted: true }
    })()
  }

  const listEventJobMatches = (
    input: ListEventJobMatchesInput = {}
  ): { matches: EventJobMatchRecord[] } => {
    const limit = input.limit ?? 100
    const clauses: string[] = []
    const params: unknown[] = []
    if (input.sourceEventId !== undefined) {
      clauses.push('source_event_id = ?')
      params.push(input.sourceEventId)
    }
    if (input.jobId !== undefined) {
      clauses.push('job_id = ?')
      params.push(input.jobId)
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const rows = sqlite
      .prepare(
        `SELECT * FROM event_job_matches ${where} ORDER BY event_seq DESC, job_id ASC LIMIT ?`
      )
      .all(...params, limit) as EventJobMatchRow[]
    return { matches: rows.map((row) => toEventJobMatchRecord(row)) }
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
    eventInbox: {
      insert: insertInboxEvent,
      get: getInboxEvent,
      claimPending: claimPendingInboxEvents,
      markProcessed: markInboxEventProcessed,
      markFailed: markInboxEventFailed,
    },
    insertInboxEvent,
    getInboxEvent,
    claimPendingInboxEvents,
    markInboxEventProcessed,
    markInboxEventFailed,
    listActiveEventJobs,
    getEventJobMatch,
    recordEventJobSkip,
    hasRecentMint,
    mintEventJobRun,
    listEventJobMatches,
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
