import { createHash } from 'node:crypto'
import { stableJson } from './record-json.js'
import { type JobOutputSinkAttemptRow, toJobOutputSinkAttemptRecord } from './row-codecs.js'
import type { SqliteDatabase } from './sqlite.js'
import type {
  JobOutputSink,
  JobOutputSinkAttemptRecord,
  RecordJobOutputSinkAttemptInput,
} from './store-contracts.js'

export function fingerprintJobOutputSink(sink: JobOutputSink): string {
  return `sha256:${createHash('sha256').update(stableJson(sink)).digest('hex')}`
}

export function createOutputAttempts(sqlite: SqliteDatabase) {
  const getJobOutputSinkAttempt = (input: {
    jobRunId: string
    sinkIndex: number
    sinkFingerprint: string
  }): { attempt: JobOutputSinkAttemptRecord | undefined } => {
    const row = sqlite
      .prepare(
        `
          SELECT *
          FROM job_output_sink_attempts
          WHERE job_run_id = ?
            AND sink_index = ?
            AND sink_fingerprint = ?
        `
      )
      .get(input.jobRunId, input.sinkIndex, input.sinkFingerprint) as
      | JobOutputSinkAttemptRow
      | undefined
    return {
      attempt: row === undefined ? undefined : toJobOutputSinkAttemptRecord(row),
    }
  }

  const recordJobOutputSinkAttempt = (
    input: RecordJobOutputSinkAttemptInput
  ): { attempt: JobOutputSinkAttemptRecord } => {
    const existing = getJobOutputSinkAttempt(input).attempt
    if (existing?.status === 'succeeded') {
      return { attempt: existing }
    }

    const now = input.attemptedAt
    if (existing === undefined) {
      sqlite
        .prepare(
          `
            INSERT INTO job_output_sink_attempts (
              job_run_id, sink_index, sink_fingerprint, status, attempts,
              next_attempt_at, last_attempt_at, delivered_at, delivery_request_id,
              payload_hash, body_hash, last_error, response_status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
        )
        .run(
          input.jobRunId,
          input.sinkIndex,
          input.sinkFingerprint,
          input.status,
          input.nextAttemptAt ?? null,
          now,
          input.deliveredAt ?? null,
          input.deliveryRequestId ?? null,
          input.payloadHash ?? null,
          input.bodyHash ?? null,
          input.lastError ?? null,
          input.responseStatus ?? null,
          now,
          now
        )
    } else {
      sqlite
        .prepare(
          `
            UPDATE job_output_sink_attempts
            SET status = ?,
                attempts = attempts + 1,
                next_attempt_at = ?,
                last_attempt_at = ?,
                delivered_at = ?,
                delivery_request_id = ?,
                payload_hash = ?,
                body_hash = ?,
                last_error = ?,
                response_status = ?,
                updated_at = ?
            WHERE job_run_id = ?
              AND sink_index = ?
              AND sink_fingerprint = ?
          `
        )
        .run(
          input.status,
          input.nextAttemptAt ?? null,
          now,
          input.deliveredAt ?? existing.deliveredAt ?? null,
          input.deliveryRequestId ?? existing.deliveryRequestId ?? null,
          input.payloadHash ?? existing.payloadHash ?? null,
          input.bodyHash ?? existing.bodyHash ?? null,
          input.lastError ?? null,
          input.responseStatus ?? null,
          now,
          input.jobRunId,
          input.sinkIndex,
          input.sinkFingerprint
        )
    }

    const attempt = getJobOutputSinkAttempt(input).attempt
    if (attempt === undefined) {
      throw new Error(
        `job output sink attempt not found after record: ${input.jobRunId}/${input.sinkIndex}/${input.sinkFingerprint}`
      )
    }
    return { attempt }
  }

  const listJobOutputSinkAttempts = (
    jobRunId: string
  ): { attempts: JobOutputSinkAttemptRecord[] } => {
    const rows = sqlite
      .prepare(
        `
          SELECT *
          FROM job_output_sink_attempts
          WHERE job_run_id = ?
          ORDER BY sink_index ASC, sink_fingerprint ASC
        `
      )
      .all(jobRunId) as JobOutputSinkAttemptRow[]
    return { attempts: rows.map((row) => toJobOutputSinkAttemptRecord(row)) }
  }
  return { getJobOutputSinkAttempt, recordJobOutputSinkAttempt, listJobOutputSinkAttempts }
}
