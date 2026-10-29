import type { Actor } from 'acp-core'
import { nextFireAfter } from './cron.js'
import { JobExecutionAdmissionError, assertJobExecutionAdmission } from './execution-admission.js'
import { type JobRow, actorToStamp, requireJobRow, toJobRecord } from './row-codecs.js'
import { DEFAULT_CLAIM_LIMIT } from './run-recovery.js'
import { resolveScheduleClaimPolicy } from './schedule-policy.js'
import type { SqliteDatabase } from './sqlite.js'
import type { ClaimDueJobsInput, ClaimedDueJob, JobsStore } from './store-contracts.js'

export function createScheduleClaims(
  sqlite: SqliteDatabase,
  appendJobRun: JobsStore['appendJobRun']
) {
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
        const scheduledJob = toJobRecord(row)
        const timezone = scheduledJob.schedule?.timezone
        const dueAt =
          row.next_fire_at ??
          nextFireAfter(row.schedule_cron, row.last_fire_at ?? row.created_at, timezone)
        if (dueAt === null || dueAt > now) {
          continue
        }

        const nextAfterNow = nextFireAfter(row.schedule_cron, now, timezone)
        if (input.executionIdentity !== undefined) {
          try {
            assertJobExecutionAdmission(scheduledJob, input.executionIdentity)
          } catch (error) {
            if (error instanceof JobExecutionAdmissionError) {
              input.onAdmissionRefused?.({ job: scheduledJob, code: error.code })
              continue
            }
            throw error
          }
        }
        const policy = resolveScheduleClaimPolicy({
          schedule: scheduledJob.schedule,
          dueAt,
          now,
        })
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

        const claimActor: Actor = input.actor ?? {
          kind: 'system',
          id: 'scheduler',
        }
        if (policy.skipReason !== undefined) {
          appendJobRun({
            jobId: row.job_id,
            triggeredAt: now,
            triggeredBy: policy.triggeredBy,
            status: 'skipped',
            completedAt: now,
            errorCode: policy.skipReason,
            errorMessage: policy.skipReason,
            actor: claimActor,
            actorStamp: input.actorStamp ?? actorToStamp(claimActor),
            ...(input.executionIdentity !== undefined
              ? { executionNodeId: input.executionIdentity.nodeId }
              : {}),
          })
          continue
        }

        const jobRun = appendJobRun({
          jobId: row.job_id,
          triggeredAt: now,
          triggeredBy: policy.triggeredBy,
          status: 'claimed',
          claimedAt: now,
          ...(scheduledJob.flow !== undefined &&
          input.leaseOwner !== undefined &&
          input.leaseExpiresAt !== undefined
            ? {
                leaseOwner: input.leaseOwner,
                leaseExpiresAt: input.leaseExpiresAt,
              }
            : {}),
          output: scheduledJob.output,
          actor: claimActor,
          actorStamp: input.actorStamp ?? actorToStamp(claimActor),
          ...(input.executionIdentity !== undefined
            ? { executionNodeId: input.executionIdentity.nodeId }
            : {}),
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
  return { claimDueJobs }
}
