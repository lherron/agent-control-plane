import type { JobStepRunPhase } from 'acp-core'
import {
  type JobStepRunRow,
  getJobStepRunRow,
  pickNullable,
  toJobStepRunRecord,
} from './row-codecs.js'
import type { SqliteDatabase } from './sqlite.js'
import type {
  InsertJobStepRunInput,
  JobStepRunRecord,
  UpdateJobStepRunInput,
} from './store-contracts.js'

export function createStepRuns(sqlite: SqliteDatabase) {
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
                branch_taken_json,
                error_code,
                error_message,
                started_at,
                completed_at,
                created_at,
                updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            step.branchTaken !== undefined ? JSON.stringify(step.branchTaken) : null,
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

    const nextInputAttemptId = pickNullable(
      'inputAttemptId' in patch,
      patch.inputAttemptId,
      existing.input_attempt_id
    )
    const nextRunId = pickNullable('runId' in patch, patch.runId, existing.run_id)
    const nextResultBlock = pickNullable(
      'resultBlock' in patch,
      patch.resultBlock,
      existing.result_block
    )
    const nextResultJson =
      'result' in patch
        ? patch.result === null || patch.result === undefined
          ? null
          : JSON.stringify(patch.result)
        : existing.result_json
    const nextBranchTakenJson =
      'branchTaken' in patch
        ? patch.branchTaken === null || patch.branchTaken === undefined
          ? null
          : JSON.stringify(patch.branchTaken)
        : existing.branch_taken_json
    const nextErrorCode = pickNullable('error' in patch, patch.error?.code, existing.error_code)
    const nextErrorMessage = pickNullable(
      'error' in patch,
      patch.error?.message,
      existing.error_message
    )
    const nextStartedAt = pickNullable('startedAt' in patch, patch.startedAt, existing.started_at)
    const nextCompletedAt = pickNullable(
      'completedAt' in patch,
      patch.completedAt,
      existing.completed_at
    )
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
              branch_taken_json = ?,
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
        nextBranchTakenJson,
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
    return {
      jobStepRun: row === undefined ? undefined : toJobStepRunRecord(row),
    }
  }
  return { insertJobStepRuns, updateJobStepRun, listJobStepRuns, getJobStepRun }
}
