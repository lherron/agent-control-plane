import { randomUUID } from 'node:crypto'
import type { Actor, BranchTaken, JobFlow, JobStepRunPhase, JobStepRunStatus } from 'acp-core'
import { parseExecutionNodesJson } from './execution-admission.js'
import { parseTriggerJson } from './schedule-policy.js'
import type { SqliteDatabase } from './sqlite.js'
import type {
  EventJobMatchRecord,
  EventJobOutcome,
  EventJobSkipReason,
  InboxEventRecord,
  InboxEventStatus,
  JobOutputConfig,
  JobOutputSinkAttemptRecord,
  JobOutputSinkAttemptStatus,
  JobRecord,
  JobRunRecord,
  JobRunStatus,
  JobRunTrigger,
  JobSchedule,
  JobStepRunRecord,
  ScheduleJobSkipReason,
} from './store-contracts.js'

export type JobRow = {
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
  output_json: string | null
  flow_json: string | null
  execution_nodes_json: string | null
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

export type JobRunRow = {
  job_run_id: string
  job_id: string
  execution_node_id: string | null
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
  output_json: string | null
  source_json: string | null
  retry_attempts: number | null
  next_attempt_at: string | null
  last_retry_error: string | null
  actor_kind: Actor['kind'] | null
  actor_id: string | null
  actor_display_name: string | null
  actor_stamp: string
  created_at: string
  updated_at: string
}

export type InboxEventRow = {
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

export type EventJobMatchRow = {
  source_event_id: string
  job_id: string
  event_seq: number
  outcome: EventJobOutcome
  reason: EventJobSkipReason | null
  job_run_id: string | null
  target_task_id: string | null
  created_at: string
}

export type JobOutputSinkAttemptRow = {
  job_run_id: string
  sink_index: number
  sink_fingerprint: string
  status: JobOutputSinkAttemptStatus
  attempts: number
  next_attempt_at: string | null
  last_attempt_at: string | null
  delivered_at: string | null
  delivery_request_id: string | null
  payload_hash: string | null
  body_hash: string | null
  last_error: string | null
  response_status: number | null
  created_at: string
  updated_at: string
}

export type JobStepRunRow = {
  job_run_id: string
  phase: JobStepRunPhase
  step_id: string
  status: JobStepRunStatus
  attempt: number
  input_attempt_id: string | null
  run_id: string | null
  result_block: string | null
  result_json: string | null
  branch_taken_json: string | null
  error_code: string | null
  error_message: string | null
  started_at: string | null
  completed_at: string | null
  created_at: string
  updated_at: string
}

/** Generate a prefixed, hyphen-stripped, 12-char id (e.g. `job_ab12cd34ef56`). */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`
}

/**
 * Resolves a nullable patch column: when the key is present on the patch object
 * the supplied value (coalesced to null) wins, otherwise the existing row value
 * is kept. Encodes the `key in patch ? (patch[key] ?? null) : existing` idiom.
 */
export function pickNullable<T>(
  hasKey: boolean,
  value: T | null | undefined,
  existing: T | null
): T | null {
  return hasKey ? (value ?? null) : existing
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

export function actorToStamp(actor: Actor): string {
  return `${actor.kind}:${actor.id}`
}

export function resolveActor(actor?: Actor | undefined): Actor {
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

export function toJobRecord(row: JobRow): JobRecord {
  const flow = parseOptionalJsonRecord(row.flow_json, 'flow') as JobFlow | undefined
  const trigger = parseTriggerJson(row.trigger_json)
  const output = parseOptionalJsonRecord(row.output_json, 'output') as JobOutputConfig | undefined
  const schedule =
    row.schedule_json !== null
      ? (parseJsonRecord(row.schedule_json, 'schedule') as JobSchedule)
      : undefined
  const executionNodes =
    row.execution_nodes_json === null
      ? undefined
      : parseExecutionNodesJson(row.execution_nodes_json)
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
    ...(output !== undefined ? { output } : {}),
    ...(flow !== undefined ? { flow } : {}),
    ...(executionNodes !== undefined ? { executionNodes } : {}),
    disabled: row.disabled !== 0,
    ...(row.last_fire_at !== null ? { lastFireAt: row.last_fire_at } : {}),
    ...(row.next_fire_at !== null ? { nextFireAt: row.next_fire_at } : {}),
    actor: rowToActor(row),
    actorStamp: row.actor_stamp,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.archived_at !== null ? { archivedAt: row.archived_at } : {}),
  }
}

export function toInboxEventRecord(row: InboxEventRow): InboxEventRecord {
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

export function toEventJobMatchRecord(row: EventJobMatchRow): EventJobMatchRecord {
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

export function toJobRunRecord(row: JobRunRow): JobRunRecord {
  const output = parseOptionalJsonRecord(row.output_json, 'output') as JobOutputConfig | undefined
  const reason = parseScheduleJobSkipReason(row.error_code)
  return {
    jobRunId: row.job_run_id,
    jobId: row.job_id,
    ...(row.execution_node_id !== null ? { executionNodeId: row.execution_node_id } : {}),
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
    ...(row.completed_at === null && row.retry_attempts !== null ? { completedAt: undefined } : {}),
    ...(row.resolved_scope_ref !== null ? { resolvedScopeRef: row.resolved_scope_ref } : {}),
    ...(row.resolved_lane_ref !== null ? { resolvedLaneRef: row.resolved_lane_ref } : {}),
    ...(row.resolved_input_json !== null
      ? {
          resolvedInput: parseJsonRecord(row.resolved_input_json, 'resolvedInput'),
        }
      : {}),
    ...(output !== undefined ? { output } : {}),
    ...(row.source_json !== null ? { source: parseJsonRecord(row.source_json, 'source') } : {}),
    ...(row.retry_attempts !== null ? { retryAttempts: row.retry_attempts } : {}),
    ...(row.next_attempt_at !== null ? { nextAttemptAt: row.next_attempt_at } : {}),
    ...(row.last_retry_error !== null ? { lastRetryError: row.last_retry_error } : {}),
    ...(reason !== undefined ? { reason } : {}),
    actor: rowToActor(row),
    actorStamp: row.actor_stamp,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function parseScheduleJobSkipReason(value: string | null): ScheduleJobSkipReason | undefined {
  return value === 'schedule_window' || value === 'stale_catch_up_suppressed' ? value : undefined
}

export function toJobOutputSinkAttemptRecord(
  row: JobOutputSinkAttemptRow
): JobOutputSinkAttemptRecord {
  return {
    jobRunId: row.job_run_id,
    sinkIndex: row.sink_index,
    sinkFingerprint: row.sink_fingerprint,
    status: row.status,
    attempts: row.attempts,
    ...(row.next_attempt_at !== null ? { nextAttemptAt: row.next_attempt_at } : {}),
    ...(row.last_attempt_at !== null ? { lastAttemptAt: row.last_attempt_at } : {}),
    ...(row.delivered_at !== null ? { deliveredAt: row.delivered_at } : {}),
    ...(row.delivery_request_id !== null ? { deliveryRequestId: row.delivery_request_id } : {}),
    ...(row.payload_hash !== null ? { payloadHash: row.payload_hash } : {}),
    ...(row.body_hash !== null ? { bodyHash: row.body_hash } : {}),
    ...(row.last_error !== null ? { lastError: row.last_error } : {}),
    ...(row.response_status !== null ? { responseStatus: row.response_status } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function toJobStepRunRecord(row: JobStepRunRow): JobStepRunRecord {
  const result = parseOptionalJsonRecord(row.result_json, 'result')
  const branchTaken = parseOptionalBranchTaken(row.branch_taken_json)
  const degradation = readJobStepRunDegradation(result?.['degradation'])
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
    ...(branchTaken !== undefined ? { branchTaken } : {}),
    ...(degradation !== undefined ? { degradation } : {}),
    error:
      row.error_code !== null && row.error_message !== null
        ? { code: row.error_code, message: row.error_message }
        : undefined,
    ...(row.started_at !== null ? { startedAt: row.started_at } : {}),
    ...(row.completed_at !== null ? { completedAt: row.completed_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function parseOptionalBranchTaken(value: string | null): BranchTaken | undefined {
  if (value === null) {
    return undefined
  }

  const parsed = parseJsonRecord(value, 'branchTaken')
  if (
    (parsed['kind'] !== 'exitCode' &&
      parsed['kind'] !== 'outcome' &&
      parsed['kind'] !== 'default') ||
    typeof parsed['key'] !== 'string' ||
    typeof parsed['target'] !== 'string'
  ) {
    throw new Error('branchTaken must decode to a branch record')
  }
  return parsed as BranchTaken
}

function readJobStepRunDegradation(
  value: unknown
): Readonly<{ code: string; [key: string]: unknown }> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined
  }

  const degradation = value as Record<string, unknown>
  return typeof degradation['code'] === 'string'
    ? (degradation as Readonly<{ code: string; [key: string]: unknown }>)
    : undefined
}

export function requireJobRow(sqlite: SqliteDatabase, jobId: string): JobRow {
  const row = getJobRow(sqlite, jobId)
  if (row === undefined) {
    throw new Error(`job not found: ${jobId}`)
  }

  return row
}

export function requireAnyJobRow(sqlite: SqliteDatabase, jobId: string): JobRow {
  const row = sqlite.prepare('SELECT * FROM jobs WHERE job_id = ?').get(jobId) as JobRow | undefined
  if (row === undefined) {
    throw new Error(`job not found: ${jobId}`)
  }

  return row
}

export function getJobRow(sqlite: SqliteDatabase, jobId: string): JobRow | undefined {
  return sqlite.prepare('SELECT * FROM jobs WHERE job_id = ? AND archived_at IS NULL').get(jobId) as
    | JobRow
    | undefined
}

export function getJobRunRow(sqlite: SqliteDatabase, jobRunId: string): JobRunRow | undefined {
  return sqlite.prepare('SELECT * FROM job_runs WHERE job_run_id = ?').get(jobRunId) as
    | JobRunRow
    | undefined
}

export function getJobStepRunRow(
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
