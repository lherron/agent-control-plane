import { randomUUID } from 'node:crypto'

import type { InputApplication, InputApplicationStatus } from 'acp-core'

import type { InputApplicationCreateInput, InputApplicationUpdateInput } from '../types.js'
import type { RepoContext } from './shared.js'

type InputApplicationRow = {
  input_application_id: string
  input_attempt_id: string
  target_run_id: string | null
  hrc_run_id: string | null
  host_session_id: string | null
  generation: number | null
  runtime_id: string | null
  status: InputApplicationStatus
  delivery_attempts: number
  last_error_code: string | null
  last_error_message: string | null
  created_at: string
  updated_at: string
}

function mapRow(row: InputApplicationRow): InputApplication {
  return {
    inputApplicationId: row.input_application_id,
    inputAttemptId: row.input_attempt_id,
    ...(row.target_run_id !== null ? { targetRunId: row.target_run_id } : {}),
    ...(row.hrc_run_id !== null ? { hrcRunId: row.hrc_run_id } : {}),
    ...(row.host_session_id !== null ? { hostSessionId: row.host_session_id } : {}),
    ...(row.generation !== null ? { generation: row.generation } : {}),
    ...(row.runtime_id !== null ? { runtimeId: row.runtime_id } : {}),
    status: row.status,
    deliveryAttempts: row.delivery_attempts,
    ...(row.last_error_code !== null ? { lastErrorCode: row.last_error_code } : {}),
    ...(row.last_error_message !== null ? { lastErrorMessage: row.last_error_message } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class InputApplicationRepo {
  constructor(private readonly context: RepoContext) {}

  create(input: InputApplicationCreateInput): InputApplication {
    const now = new Date().toISOString()
    const inputApplicationId = `iap_${randomUUID().replace(/-/g, '').slice(0, 12)}`
    this.context.sqlite
      .prepare(
        `INSERT INTO input_applications (
           input_application_id,
           input_attempt_id,
           target_run_id,
           hrc_run_id,
           host_session_id,
           generation,
           runtime_id,
           status,
           delivery_attempts,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        inputApplicationId,
        input.inputAttemptId,
        input.targetRunId ?? null,
        input.hrcRunId ?? null,
        input.hostSessionId ?? null,
        input.generation ?? null,
        input.runtimeId ?? null,
        input.status ?? 'pending',
        0,
        now,
        now
      )

    return this.require(inputApplicationId)
  }

  getById(inputApplicationId: string): InputApplication | undefined {
    const row = this.context.sqlite
      .prepare(`${this.selectSql()} WHERE input_application_id = ?`)
      .get(inputApplicationId) as InputApplicationRow | undefined

    return row === undefined ? undefined : mapRow(row)
  }

  update(inputApplicationId: string, patch: InputApplicationUpdateInput): InputApplication {
    const current = this.require(inputApplicationId)
    const now = new Date().toISOString()
    this.context.sqlite
      .prepare(
        `UPDATE input_applications
            SET hrc_run_id = ?,
                host_session_id = ?,
                generation = ?,
                runtime_id = ?,
                status = ?,
                delivery_attempts = ?,
                last_error_code = ?,
                last_error_message = ?,
                updated_at = ?
          WHERE input_application_id = ?`
      )
      .run(
        patch.hrcRunId ?? current.hrcRunId ?? null,
        patch.hostSessionId ?? current.hostSessionId ?? null,
        patch.generation ?? current.generation ?? null,
        patch.runtimeId ?? current.runtimeId ?? null,
        patch.status ?? current.status,
        patch.deliveryAttempts ?? current.deliveryAttempts,
        patch.lastErrorCode ?? current.lastErrorCode ?? null,
        patch.lastErrorMessage ?? current.lastErrorMessage ?? null,
        now,
        inputApplicationId
      )

    return this.require(inputApplicationId)
  }

  private require(inputApplicationId: string): InputApplication {
    const application = this.getById(inputApplicationId)
    if (application === undefined) {
      throw new Error(`input application not found: ${inputApplicationId}`)
    }
    return application
  }

  private selectSql(): string {
    return `SELECT input_application_id,
                   input_attempt_id,
                   target_run_id,
                   hrc_run_id,
                   host_session_id,
                   generation,
                   runtime_id,
                   status,
                   delivery_attempts,
                   last_error_code,
                   last_error_message,
                   created_at,
                   updated_at
              FROM input_applications`
  }
}
