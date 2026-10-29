import { assertJobExecutionAdmission } from './execution-admission.js'
import { claimWithLease } from './lease-claims.js'
import {
  type JobRunRow,
  actorToStamp,
  getJobRunRow,
  newId,
  pickNullable,
  requireAnyJobRow,
  resolveActor,
  toJobRecord,
  toJobRunRecord,
} from './row-codecs.js'
import type { SqliteDatabase } from './sqlite.js'
import type {
  AppendJobRunInput,
  ClaimDueJobRunsInput,
  JobExecutionIdentity,
  JobRecord,
  JobRunRecord,
  UpdateJobRunInput,
} from './store-contracts.js'

export function createRunRecords(sqlite: SqliteDatabase) {
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
            execution_node_id,
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
            output_json,
            source_json,
            retry_attempts,
            next_attempt_at,
            last_retry_error,
            actor_kind,
            actor_id,
            actor_display_name,
            actor_stamp,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        jobRunId,
        input.jobId,
        input.executionNodeId ?? null,
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
        input.output !== undefined ? JSON.stringify(input.output) : null,
        input.source !== undefined ? JSON.stringify(input.source) : null,
        input.retryAttempts ?? null,
        input.nextAttemptAt ?? null,
        input.lastRetryError ?? null,
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

    const nextLeaseOwner = pickNullable(
      'leaseOwner' in patch,
      patch.leaseOwner,
      existing.lease_owner
    )
    const nextLeaseExpiresAt = pickNullable(
      'leaseExpiresAt' in patch,
      patch.leaseExpiresAt,
      existing.lease_expires_at
    )
    const nextErrorCode = pickNullable('errorCode' in patch, patch.errorCode, existing.error_code)
    const nextErrorMessage = pickNullable(
      'errorMessage' in patch,
      patch.errorMessage,
      existing.error_message
    )
    const nextRetryAttempts = pickNullable(
      'retryAttempts' in patch,
      patch.retryAttempts,
      existing.retry_attempts
    )
    const nextNextAttemptAt = pickNullable(
      'nextAttemptAt' in patch,
      patch.nextAttemptAt,
      existing.next_attempt_at
    )
    const nextLastRetryError = pickNullable(
      'lastRetryError' in patch,
      patch.lastRetryError,
      existing.last_retry_error
    )
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
              retry_attempts = ?,
              next_attempt_at = ?,
              last_retry_error = ?,
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
        nextErrorCode,
        nextErrorMessage,
        nextLeaseOwner,
        nextLeaseExpiresAt,
        nextClaimedAt,
        nextDispatchedAt,
        nextCompletedAt,
        nextRetryAttempts,
        nextNextAttemptAt,
        nextLastRetryError,
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

  const claimDueJobRuns = (input: ClaimDueJobRunsInput): { jobRuns: JobRunRecord[] } => {
    const jobRuns = claimWithLease<{ job_run_id: string }, JobRunRecord>(sqlite, {
      selectSql: `
            SELECT job_run_id
            FROM job_runs
            WHERE triggered_at <= ?
              AND (
                status = 'pending'
                OR (status = 'claimed' AND (lease_expires_at IS NULL OR lease_expires_at <= ?))
              )
            ORDER BY triggered_at ASC, job_run_id ASC
            LIMIT ?
          `,
      selectParams: [input.now, input.now, input.limit],
      claimSql: `
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
            `,
      claimParams: (candidate) => [
        input.leaseOwner,
        input.leaseExpiresAt,
        input.now,
        input.now,
        candidate.job_run_id,
        input.now,
        input.now,
      ],
      reread: (candidate) => {
        const row = getJobRunRow(sqlite, candidate.job_run_id)
        return row === undefined ? undefined : toJobRunRecord(row)
      },
    })

    return { jobRuns }
  }

  const createJobRun = (
    jobId: string,
    input: Omit<AppendJobRunInput, 'jobId'>,
    executionIdentity?: JobExecutionIdentity | undefined
  ): { job: JobRecord; jobRun: JobRunRecord } => {
    return sqlite.transaction(() => {
      const job = toJobRecord(requireAnyJobRow(sqlite, jobId))
      if (executionIdentity !== undefined) {
        assertJobExecutionAdmission(job, executionIdentity)
      }
      const jobRun = appendJobRun({
        ...input,
        jobId,
        output: input.output ?? job.output,
        ...(executionIdentity !== undefined ? { executionNodeId: executionIdentity.nodeId } : {}),
      }).jobRun
      return { job, jobRun }
    })()
  }

  const stampLegacyNonterminalJobRuns = (
    executionNodeId: string
  ): {
    stamped: number
  } => {
    const nodeId = executionNodeId.trim()
    if (nodeId.length === 0) {
      throw new Error('executionNodeId must be non-empty')
    }
    const now = new Date().toISOString()
    const result = sqlite
      .prepare(
        `
          UPDATE job_runs
          SET execution_node_id = ?,
              updated_at = ?
          WHERE execution_node_id IS NULL
            AND status IN ('pending', 'claimed', 'dispatched')
        `
      )
      .run(nodeId, now)
    return { stamped: result.changes }
  }
  return {
    appendJobRun,
    listJobRuns,
    getJobRun,
    updateJobRun,
    claimDueJobRuns,
    createJobRun,
    stampLegacyNonterminalJobRuns,
  }
}
