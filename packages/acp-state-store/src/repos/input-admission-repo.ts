import type { InputAdmissionRecord } from 'acp-core'

import type { InputAdmissionCreateInput, InputAdmissionUpdateInput } from '../types.js'
import type { RepoContext } from './shared.js'

type InputAdmissionRow = {
  input_attempt_id: string
  admission_kind: InputAdmissionRecord['admissionKind']
  intent_json: string
  original_response_json: string
  current_state_json: string | null
  run_id: string | null
  input_application_id: string | null
  queue_item_id: string | null
  status: string
  created_at: string
  updated_at: string
}

function mapRow(row: InputAdmissionRow): InputAdmissionRecord {
  return {
    inputAttemptId: row.input_attempt_id,
    admissionKind: row.admission_kind,
    intent: JSON.parse(row.intent_json) as InputAdmissionRecord['intent'],
    originalResponse: JSON.parse(row.original_response_json) as Record<string, unknown>,
    ...(row.current_state_json !== null
      ? { currentState: JSON.parse(row.current_state_json) as Record<string, unknown> }
      : {}),
    ...(row.run_id !== null ? { runId: row.run_id } : {}),
    ...(row.input_application_id !== null ? { inputApplicationId: row.input_application_id } : {}),
    ...(row.queue_item_id !== null ? { queueItemId: row.queue_item_id } : {}),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class InputAdmissionRepo {
  constructor(private readonly context: RepoContext) {}

  create(input: InputAdmissionCreateInput): InputAdmissionRecord {
    const now = new Date().toISOString()
    this.context.sqlite
      .prepare(
        `INSERT INTO input_admissions (
           input_attempt_id,
           admission_kind,
           intent_json,
           original_response_json,
           current_state_json,
           run_id,
           input_application_id,
           queue_item_id,
           status,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.inputAttemptId,
        input.admissionKind,
        JSON.stringify(input.intent),
        JSON.stringify(input.originalResponse),
        input.currentState === undefined ? null : JSON.stringify(input.currentState),
        input.runId ?? null,
        input.inputApplicationId ?? null,
        input.queueItemId ?? null,
        input.status,
        now,
        now
      )

    return this.require(input.inputAttemptId)
  }

  getByInputAttemptId(inputAttemptId: string): InputAdmissionRecord | undefined {
    const row = this.context.sqlite
      .prepare(
        `SELECT input_attempt_id,
                admission_kind,
                intent_json,
                original_response_json,
                current_state_json,
                run_id,
                input_application_id,
                queue_item_id,
                status,
                created_at,
                updated_at
           FROM input_admissions
          WHERE input_attempt_id = ?`
      )
      .get(inputAttemptId) as InputAdmissionRow | undefined

    return row === undefined ? undefined : mapRow(row)
  }

  update(inputAttemptId: string, patch: InputAdmissionUpdateInput): InputAdmissionRecord {
    const current = this.require(inputAttemptId)
    const now = new Date().toISOString()
    this.context.sqlite
      .prepare(
        `UPDATE input_admissions
            SET current_state_json = ?,
                run_id = ?,
                input_application_id = ?,
                queue_item_id = ?,
                status = ?,
                updated_at = ?
          WHERE input_attempt_id = ?`
      )
      .run(
        patch.currentState === undefined
          ? current.currentState === undefined
            ? null
            : JSON.stringify(current.currentState)
          : JSON.stringify(patch.currentState),
        patch.runId ?? current.runId ?? null,
        patch.inputApplicationId ?? current.inputApplicationId ?? null,
        patch.queueItemId ?? current.queueItemId ?? null,
        patch.status ?? current.status,
        now,
        inputAttemptId
      )

    return this.require(inputAttemptId)
  }

  private require(inputAttemptId: string): InputAdmissionRecord {
    const record = this.getByInputAttemptId(inputAttemptId)
    if (record === undefined) {
      throw new Error(`input admission not found: ${inputAttemptId}`)
    }
    return record
  }
}
