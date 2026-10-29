import {
  type JobRunRow,
  requireAnyJobRow,
  requireJobRow,
  toJobRecord,
  toJobRunRecord,
} from './row-codecs.js'
import type { SqliteDatabase } from './sqlite.js'
import type { ClaimedDueJob, RunRecoveryInput } from './store-contracts.js'

/** Default page size for inflight/due claim queries. */
export const DEFAULT_CLAIM_LIMIT = 100

export function createRunRecovery(sqlite: SqliteDatabase) {
  const listInflightFlowJobRuns = (input: RunRecoveryInput = {}): ClaimedDueJob[] => {
    const limit = input.limit ?? DEFAULT_CLAIM_LIMIT
    const now = input.now ?? new Date().toISOString()
    const rows = sqlite
      .prepare(
        `
          SELECT jr.*
          FROM job_runs jr
          JOIN jobs j ON j.job_id = jr.job_id
          WHERE (
              jr.status = 'dispatched'
              OR (
                jr.status = 'claimed'
                AND (jr.lease_expires_at IS NULL OR jr.lease_expires_at <= ?)
              )
            )
            AND j.archived_at IS NULL
            AND j.flow_json IS NOT NULL
            ${input.executionNodeId !== undefined ? 'AND jr.execution_node_id = ?' : ''}
          ORDER BY jr.triggered_at ASC, jr.job_run_id ASC
          LIMIT ?
        `
      )
      .all(
        now,
        ...(input.executionNodeId !== undefined ? [input.executionNodeId] : []),
        limit
      ) as JobRunRow[]

    return rows.map((row) => ({
      job: toJobRecord(requireJobRow(sqlite, row.job_id)),
      jobRun: toJobRunRecord(row),
    }))
  }

  const listJobRunReaperCandidates = (input: RunRecoveryInput = {}): ClaimedDueJob[] => {
    const limit = input.limit ?? DEFAULT_CLAIM_LIMIT
    const now = input.now ?? new Date().toISOString()
    const rows = sqlite
      .prepare(
        `
          SELECT jr.*
          FROM job_runs jr
          JOIN jobs j ON j.job_id = jr.job_id
          WHERE (
              jr.status = 'dispatched'
              OR (
                jr.status = 'claimed'
                AND (jr.lease_expires_at IS NULL OR jr.lease_expires_at <= ?)
              )
            )
            AND (
              j.flow_json IS NOT NULL
              OR j.archived_at IS NOT NULL
              OR (
                jr.status = 'claimed'
                AND j.flow_json IS NULL
                AND jr.lease_expires_at IS NOT NULL
                AND jr.lease_expires_at <= ?
              )
              OR (
                jr.status = 'dispatched'
                AND j.flow_json IS NULL
                AND jr.input_attempt_id IS NULL
                AND jr.run_id IS NULL
              )
            )
            ${input.executionNodeId !== undefined ? 'AND jr.execution_node_id = ?' : ''}
          ORDER BY jr.triggered_at ASC, jr.job_run_id ASC
          LIMIT ?
        `
      )
      .all(
        now,
        now,
        ...(input.executionNodeId !== undefined ? [input.executionNodeId] : []),
        limit
      ) as JobRunRow[]

    return rows.map((row) => ({
      job: toJobRecord(requireAnyJobRow(sqlite, row.job_id)),
      jobRun: toJobRunRecord(row),
    }))
  }

  const listDispatchedNonFlowJobRuns = (input: RunRecoveryInput = {}): ClaimedDueJob[] => {
    const limit = input.limit ?? DEFAULT_CLAIM_LIMIT
    const now = input.now ?? new Date().toISOString()
    // A run with an output sink still in retry backoff has nothing to do this
    // pass; leaving it out keeps a pile of undeliverable runs from filling the
    // window and starving newer runs (T-09996).
    const rows = sqlite
      .prepare(
        `
          SELECT jr.*
          FROM job_runs jr
          JOIN jobs j ON j.job_id = jr.job_id
          WHERE jr.status = 'dispatched'
            AND j.archived_at IS NULL
            AND j.flow_json IS NULL
            ${input.executionNodeId !== undefined ? 'AND jr.execution_node_id = ?' : ''}
            AND NOT EXISTS (
              SELECT 1
              FROM job_output_sink_attempts a
              WHERE a.job_run_id = jr.job_run_id
                AND a.status <> 'succeeded'
                AND a.next_attempt_at > ?
            )
          ORDER BY jr.dispatched_at ASC, jr.job_run_id ASC
          LIMIT ?
        `
      )
      .all(
        ...(input.executionNodeId !== undefined ? [input.executionNodeId] : []),
        now,
        limit
      ) as JobRunRow[]

    return rows.map((row) => ({
      job: toJobRecord(requireJobRow(sqlite, row.job_id)),
      jobRun: toJobRunRecord(row),
    }))
  }
  return { listInflightFlowJobRuns, listJobRunReaperCandidates, listDispatchedNonFlowJobRuns }
}
