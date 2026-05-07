import { randomUUID } from 'node:crypto'

import type {
  InputAdmissionKind,
  InputAdmissionRecord,
  InputApplication,
  InputApplicationStatus,
} from 'acp-core'

import type {
  HrcActiveRunContributionResponse,
  InputAdmissionUpdateInput,
  InputApplicationCreateInput,
  InputApplicationUpdateInput,
} from '../types.js'
import type { RepoContext } from './shared.js'

type InputAdmissionStoreLike = {
  getByInputAttemptId(inputAttemptId: string): InputAdmissionRecord | undefined
  update(inputAttemptId: string, patch: InputAdmissionUpdateInput): InputAdmissionRecord
}

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

  listPending(): readonly InputApplication[] {
    const rows = this.context.sqlite
      .prepare(`${this.selectSql()} WHERE status = ? ORDER BY created_at, input_application_id`)
      .all('pending') as InputApplicationRow[]

    return rows.map(mapRow)
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

  reconcileFromHrcLedger(input: {
    inputApplicationId: string
    ledger: HrcActiveRunContributionResponse
    inputAdmissionStore: InputAdmissionStoreLike
  }): {
    inputApplication: InputApplication
    inputAdmission?: InputAdmissionRecord | undefined
  } {
    return reconcileInputApplicationFromHrcLedger({
      inputApplicationStore: this,
      inputAdmissionStore: input.inputAdmissionStore,
      inputApplicationId: input.inputApplicationId,
      ledger: input.ledger,
    })
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

function reconcileInputApplicationFromHrcLedger(input: {
  inputApplicationStore: Pick<InputApplicationRepo, 'getById' | 'update'>
  inputAdmissionStore: InputAdmissionStoreLike
  inputApplicationId: string
  ledger: HrcActiveRunContributionResponse
}): {
  inputApplication: InputApplication
  inputAdmission?: InputAdmissionRecord | undefined
} {
  const current = input.inputApplicationStore.getById(input.inputApplicationId)
  if (current === undefined) {
    throw new Error(`input application not found: ${input.inputApplicationId}`)
  }

  const ledgerStatus = input.ledger.status as string
  if (ledgerStatus === 'accepted' || ledgerStatus === 'duplicate') {
    const inputApplication = input.inputApplicationStore.update(input.inputApplicationId, {
      status: 'accepted',
      ...(input.ledger.runId !== undefined ? { hrcRunId: input.ledger.runId } : {}),
      ...(input.ledger.hostSessionId !== undefined
        ? { hostSessionId: input.ledger.hostSessionId }
        : {}),
      ...(input.ledger.generation !== undefined ? { generation: input.ledger.generation } : {}),
      ...(input.ledger.runtimeId !== undefined ? { runtimeId: input.ledger.runtimeId } : {}),
    })
    return {
      inputApplication,
      inputAdmission: reconcileAdmissionForApplication({
        inputAdmissionStore: input.inputAdmissionStore,
        inputApplication,
        admissionKind: 'accepted_in_flight',
        admissionStatus: 'accepted',
        applicationStatus: 'accepted',
      }),
    }
  }

  if (ledgerStatus === 'rejected' || ledgerStatus === 'failed') {
    const inputApplication = input.inputApplicationStore.update(input.inputApplicationId, {
      status: 'failed',
      ...(input.ledger.errorCode !== undefined ? { lastErrorCode: input.ledger.errorCode } : {}),
      ...(input.ledger.errorMessage !== undefined
        ? { lastErrorMessage: input.ledger.errorMessage }
        : {}),
    })
    return {
      inputApplication,
      inputAdmission: reconcileAdmissionForApplication({
        inputAdmissionStore: input.inputAdmissionStore,
        inputApplication,
        admissionKind: 'rejected',
        admissionStatus: 'rejected',
        applicationStatus: 'failed',
        ...(input.ledger.errorCode !== undefined ? { errorCode: input.ledger.errorCode } : {}),
        ...(input.ledger.errorMessage !== undefined
          ? { errorMessage: input.ledger.errorMessage }
          : {}),
      }),
    }
  }

  const inputApplication = input.inputApplicationStore.update(input.inputApplicationId, {
    status: 'pending',
    ...(input.ledger.runId !== undefined ? { hrcRunId: input.ledger.runId } : {}),
    ...(input.ledger.hostSessionId !== undefined
      ? { hostSessionId: input.ledger.hostSessionId }
      : {}),
    ...(input.ledger.generation !== undefined ? { generation: input.ledger.generation } : {}),
    ...(input.ledger.runtimeId !== undefined ? { runtimeId: input.ledger.runtimeId } : {}),
  })
  return {
    inputApplication,
    inputAdmission: reconcileAdmissionForApplication({
      inputAdmissionStore: input.inputAdmissionStore,
      inputApplication,
      admissionKind: 'admission_pending',
      admissionStatus: 'pending',
      applicationStatus: 'pending',
    }),
  }
}

function reconcileAdmissionForApplication(input: {
  inputAdmissionStore: InputAdmissionStoreLike
  inputApplication: InputApplication
  admissionKind: InputAdmissionKind
  admissionStatus: string
  applicationStatus: InputApplicationStatus
  errorCode?: string | undefined
  errorMessage?: string | undefined
}): InputAdmissionRecord | undefined {
  const admission = input.inputAdmissionStore.getByInputAttemptId(
    input.inputApplication.inputAttemptId
  )
  if (admission === undefined) {
    return undefined
  }

  const currentState = {
    ...(admission.currentState ?? {}),
    applicationStatus: input.applicationStatus,
    inputApplicationId: input.inputApplication.inputApplicationId,
    ...(input.errorCode !== undefined ? { errorCode: input.errorCode } : {}),
    ...(input.errorMessage !== undefined ? { errorMessage: input.errorMessage } : {}),
  }

  return input.inputAdmissionStore.update(admission.inputAttemptId, {
    admissionKind:
      admission.admissionKind === 'admission_pending'
        ? input.admissionKind
        : admission.admissionKind,
    currentState,
    status: input.admissionStatus,
    inputApplicationId: input.inputApplication.inputApplicationId,
  })
}
