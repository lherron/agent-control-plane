import {
  type EventJobMatchRow,
  requireJobRow,
  toEventJobMatchRecord,
  toJobRecord,
} from './row-codecs.js'
import type { SqliteDatabase } from './sqlite.js'
import type {
  EventJobMatchRecord,
  JobRunRecord,
  JobsStore,
  ListEventJobMatchesInput,
  MintEventJobRunInput,
  RecordEventJobSkipInput,
} from './store-contracts.js'

export function createEventMatches(
  sqlite: SqliteDatabase,
  appendJobRun: JobsStore['appendJobRun'],
  getJobRun: JobsStore['getJobRun']
) {
  const getEventJobMatch = (
    sourceEventId: string,
    jobId: string
  ): { match: EventJobMatchRecord | undefined } => {
    const row = sqlite
      .prepare('SELECT * FROM event_job_matches WHERE source_event_id = ? AND job_id = ?')
      .get(sourceEventId, jobId) as EventJobMatchRow | undefined
    return {
      match: row === undefined ? undefined : toEventJobMatchRecord(row),
    }
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
      const job = toJobRecord(requireJobRow(sqlite, input.jobId))
      const jobRun = appendJobRun({
        jobId: input.jobId,
        triggeredAt: now,
        triggeredBy: 'webhook',
        status: 'claimed',
        claimedAt: now,
        resolvedScopeRef: input.resolvedScopeRef,
        resolvedLaneRef: input.resolvedLaneRef,
        resolvedInput: input.resolvedInput,
        output: job.output,
        source: input.source,
        ...(input.actor !== undefined ? { actor: input.actor } : {}),
        ...(input.actorStamp !== undefined ? { actorStamp: input.actorStamp } : {}),
        ...(input.executionIdentity !== undefined
          ? { executionNodeId: input.executionIdentity.nodeId }
          : {}),
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
  return {
    getEventJobMatch,
    recordEventJobSkip,
    hasRecentMint,
    mintEventJobRun,
    listEventJobMatches,
  }
}
