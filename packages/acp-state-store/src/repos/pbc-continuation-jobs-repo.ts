import type { RepoContext } from './shared.js'
import { shortId } from './shared.js'

export type PbcContinuationJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export type PbcContinuationJob = {
  jobId: string
  taskId: string
  workflowRef: string
  revisionAtAdmission: string
  idempotencyKey: string
  status: PbcContinuationJobStatus
  attempt: number
  leaseOwner?: string
  leaseExpiresAt?: string
  stopReason?: string
  resultJson?: unknown
  errorJson?: unknown
  createdAt: string
  startedAt?: string
  finishedAt?: string
  updatedAt: string
}

export type PbcContinuationJobAdmitInput = {
  taskId: string
  workflowRef: string
  revisionAtAdmission: string
  idempotencyKey: string
}

export type PbcContinuationJobAdmitResult = { job: PbcContinuationJob; created: boolean }
export type PbcContinuationJobAcquireResult = { job: PbcContinuationJob; acquired: boolean }

const TERMINAL_STATUSES: ReadonlySet<PbcContinuationJobStatus> = new Set([
  'succeeded',
  'failed',
  'cancelled',
])

type PbcContinuationJobRow = {
  job_id: string
  task_id: string
  workflow_ref: string
  revision_at_admission: string
  idempotency_key: string
  status: PbcContinuationJobStatus
  attempt: number
  lease_owner: string | null
  lease_expires_at: string | null
  stop_reason: string | null
  result_json: string | null
  error_json: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
  updated_at: string
}

const SELECT_COLUMNS = `job_id, task_id, workflow_ref, revision_at_admission, idempotency_key,
                        status, attempt, lease_owner, lease_expires_at, stop_reason,
                        result_json, error_json, created_at, started_at, finished_at, updated_at`

function mapRow(row: PbcContinuationJobRow): PbcContinuationJob {
  return {
    jobId: row.job_id,
    taskId: row.task_id,
    workflowRef: row.workflow_ref,
    revisionAtAdmission: row.revision_at_admission,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    attempt: row.attempt,
    ...(row.lease_owner !== null ? { leaseOwner: row.lease_owner } : {}),
    ...(row.lease_expires_at !== null ? { leaseExpiresAt: row.lease_expires_at } : {}),
    ...(row.stop_reason !== null ? { stopReason: row.stop_reason } : {}),
    ...(row.result_json !== null ? { resultJson: JSON.parse(row.result_json) as unknown } : {}),
    ...(row.error_json !== null ? { errorJson: JSON.parse(row.error_json) as unknown } : {}),
    createdAt: row.created_at,
    ...(row.started_at !== null ? { startedAt: row.started_at } : {}),
    ...(row.finished_at !== null ? { finishedAt: row.finished_at } : {}),
    updatedAt: row.updated_at,
  }
}

export class PbcContinuationJobsRepo {
  constructor(private readonly context: RepoContext) {}

  admit(input: PbcContinuationJobAdmitInput): PbcContinuationJobAdmitResult {
    return this.context.sqlite.transaction((): PbcContinuationJobAdmitResult => {
      const existing = this.findByCompositeKey(input)
      if (existing !== undefined) {
        return { job: existing, created: false }
      }

      const now = new Date().toISOString()
      const jobId = shortId('job_')
      this.context.sqlite
        .prepare(
          `INSERT INTO pbc_continuation_jobs (
             job_id, task_id, workflow_ref, revision_at_admission, idempotency_key,
             status, attempt, lease_owner, lease_expires_at, stop_reason,
             result_json, error_json, created_at, started_at, finished_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, 'queued', 0, NULL, NULL, NULL, NULL, NULL, ?, NULL, NULL, ?)`
        )
        .run(
          jobId,
          input.taskId,
          input.workflowRef,
          input.revisionAtAdmission,
          input.idempotencyKey,
          now,
          now
        )

      return { job: this.require(jobId), created: true }
    })()
  }

  get(jobId: string): PbcContinuationJob | undefined {
    const row = this.context.sqlite
      .prepare(`SELECT ${SELECT_COLUMNS} FROM pbc_continuation_jobs WHERE job_id = ?`)
      .get(jobId) as PbcContinuationJobRow | undefined

    return row === undefined ? undefined : mapRow(row)
  }

  acquireLease(input: {
    jobId: string
    leaseOwner: string
    leaseExpiresAt: string
  }): PbcContinuationJobAcquireResult {
    return this.context.sqlite.transaction((): PbcContinuationJobAcquireResult => {
      const job = this.require(input.jobId)
      const now = new Date().toISOString()

      const leaseExpired =
        job.leaseExpiresAt !== undefined && job.leaseExpiresAt <= now

      const canAcquire =
        job.status === 'queued' || (job.status === 'running' && leaseExpired)

      if (!canAcquire) {
        return { job, acquired: false }
      }

      this.context.sqlite
        .prepare(
          `UPDATE pbc_continuation_jobs
              SET status = 'running',
                  lease_owner = ?,
                  lease_expires_at = ?,
                  attempt = attempt + 1,
                  started_at = COALESCE(started_at, ?),
                  updated_at = ?
            WHERE job_id = ?`
        )
        .run(input.leaseOwner, input.leaseExpiresAt, now, now, input.jobId)

      return { job: this.require(input.jobId), acquired: true }
    })()
  }

  renewLease(input: {
    jobId: string
    leaseOwner: string
    leaseExpiresAt: string
  }): PbcContinuationJob {
    return this.context.sqlite.transaction(() => {
      const job = this.require(input.jobId)
      if (TERMINAL_STATUSES.has(job.status)) {
        throw new Error(`cannot renew lease on terminal job ${input.jobId} (status=${job.status})`)
      }
      if (job.leaseOwner !== input.leaseOwner) {
        throw new Error(
          `lease owner mismatch on job ${input.jobId}: expected ${job.leaseOwner ?? '<none>'}, got ${input.leaseOwner}`
        )
      }

      this.context.sqlite
        .prepare(
          `UPDATE pbc_continuation_jobs
              SET lease_expires_at = ?,
                  updated_at = ?
            WHERE job_id = ?`
        )
        .run(input.leaseExpiresAt, new Date().toISOString(), input.jobId)

      return this.require(input.jobId)
    })()
  }

  releaseLease(input: { jobId: string; leaseOwner: string }): PbcContinuationJob {
    return this.context.sqlite.transaction(() => {
      const job = this.require(input.jobId)
      if (job.leaseOwner !== input.leaseOwner) {
        throw new Error(
          `lease owner mismatch on job ${input.jobId}: expected ${job.leaseOwner ?? '<none>'}, got ${input.leaseOwner}`
        )
      }

      this.context.sqlite
        .prepare(
          `UPDATE pbc_continuation_jobs
              SET status = 'queued',
                  lease_owner = NULL,
                  lease_expires_at = NULL,
                  updated_at = ?
            WHERE job_id = ?`
        )
        .run(new Date().toISOString(), input.jobId)

      return this.require(input.jobId)
    })()
  }

  transition(input: {
    jobId: string
    toStatus: 'succeeded' | 'failed' | 'cancelled'
    resultJson?: unknown
    errorJson?: unknown
    stopReason?: string
  }): PbcContinuationJob {
    return this.context.sqlite.transaction(() => {
      const job = this.require(input.jobId)
      if (TERMINAL_STATUSES.has(job.status)) {
        throw new Error(
          `cannot transition job ${input.jobId} from terminal status ${job.status}`
        )
      }

      const now = new Date().toISOString()
      this.context.sqlite
        .prepare(
          `UPDATE pbc_continuation_jobs
              SET status = ?,
                  result_json = ?,
                  error_json = ?,
                  stop_reason = ?,
                  finished_at = ?,
                  updated_at = ?
            WHERE job_id = ?`
        )
        .run(
          input.toStatus,
          input.resultJson !== undefined ? JSON.stringify(input.resultJson) : null,
          input.errorJson !== undefined ? JSON.stringify(input.errorJson) : null,
          input.stopReason ?? null,
          now,
          now,
          input.jobId
        )

      return this.require(input.jobId)
    })()
  }

  /** Most recently updated job for a task, regardless of status. */
  latestForTask(taskId: string): PbcContinuationJob | undefined {
    const row = this.context.sqlite
      .prepare(
        `SELECT ${SELECT_COLUMNS} FROM pbc_continuation_jobs
          WHERE task_id = ?
       ORDER BY updated_at DESC, job_id DESC
          LIMIT 1`
      )
      .get(taskId) as PbcContinuationJobRow | undefined

    return row === undefined ? undefined : mapRow(row)
  }

  listByStatus(status: PbcContinuationJobStatus): readonly PbcContinuationJob[] {
    const rows = this.context.sqlite
      .prepare(
        `SELECT ${SELECT_COLUMNS} FROM pbc_continuation_jobs
          WHERE status = ?
       ORDER BY created_at ASC, job_id ASC`
      )
      .all(status) as PbcContinuationJobRow[]

    return rows.map(mapRow)
  }

  private findByCompositeKey(input: PbcContinuationJobAdmitInput): PbcContinuationJob | undefined {
    const row = this.context.sqlite
      .prepare(
        `SELECT ${SELECT_COLUMNS} FROM pbc_continuation_jobs
          WHERE task_id = ? AND revision_at_admission = ? AND idempotency_key = ?`
      )
      .get(input.taskId, input.revisionAtAdmission, input.idempotencyKey) as
      | PbcContinuationJobRow
      | undefined

    return row === undefined ? undefined : mapRow(row)
  }

  private require(jobId: string): PbcContinuationJob {
    const job = this.get(jobId)
    if (job === undefined) {
      throw new Error(`pbc continuation job not found: ${jobId}`)
    }

    return job
  }
}
