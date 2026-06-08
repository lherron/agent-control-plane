import type { RepoContext } from './shared.js'

export type WrkfParticipantCaptureStatus = 'pending' | 'completed'

export type WrkfParticipantCaptureRecord = {
  captureKey: string
  taskId: string
  workflowRef: string
  wrkfRunId: string
  bodyHash: string
  evidenceIds: string[]
  obligationIds: string[]
  status: WrkfParticipantCaptureStatus
  createdAt: string
  updatedAt: string
}

export type WrkfParticipantCaptureSetInput = {
  captureKey: string
  taskId: string
  workflowRef: string
  wrkfRunId: string
  bodyHash: string
  evidenceIds: string[]
  obligationIds: string[]
}

export type WrkfParticipantCaptureSetResult =
  | { state: 'created'; record: WrkfParticipantCaptureRecord }
  | { state: 'replay'; record: WrkfParticipantCaptureRecord }
  | { state: 'conflict' }

type WrkfParticipantCaptureRow = {
  capture_key: string
  task_id: string
  workflow_ref: string
  wrkf_run_id: string
  body_hash: string
  evidence_ids_json: string
  obligation_ids_json: string
  status: WrkfParticipantCaptureStatus
  created_at: string
  updated_at: string
}

function parseStringArray(value: string): string[] {
  const parsed = JSON.parse(value) as unknown
  if (!Array.isArray(parsed)) {
    throw new Error('Expected JSON array payload')
  }
  return parsed as string[]
}

function mapRow(row: WrkfParticipantCaptureRow): WrkfParticipantCaptureRecord {
  return {
    captureKey: row.capture_key,
    taskId: row.task_id,
    workflowRef: row.workflow_ref,
    wrkfRunId: row.wrkf_run_id,
    bodyHash: row.body_hash,
    evidenceIds: parseStringArray(row.evidence_ids_json),
    obligationIds: parseStringArray(row.obligation_ids_json),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class WrkfParticipantCapturesRepo {
  constructor(private readonly context: RepoContext) {}

  get(captureKey: string): WrkfParticipantCaptureRecord | undefined {
    const row = this.context.sqlite
      .prepare(
        `SELECT capture_key, task_id, workflow_ref, wrkf_run_id, body_hash,
                evidence_ids_json, obligation_ids_json, status, created_at, updated_at
           FROM wrkf_participant_captures
          WHERE capture_key = ?`
      )
      .get(captureKey) as WrkfParticipantCaptureRow | undefined

    return row === undefined ? undefined : mapRow(row)
  }

  setOrConflict(input: WrkfParticipantCaptureSetInput): WrkfParticipantCaptureSetResult {
    return this.context.sqlite.transaction((): WrkfParticipantCaptureSetResult => {
      const existing = this.get(input.captureKey)
      if (existing !== undefined) {
        if (existing.bodyHash !== input.bodyHash) {
          return { state: 'conflict' }
        }
        return { state: 'replay', record: existing }
      }

      const now = new Date().toISOString()
      this.context.sqlite
        .prepare(
          `INSERT INTO wrkf_participant_captures (
             capture_key, task_id, workflow_ref, wrkf_run_id, body_hash,
             evidence_ids_json, obligation_ids_json, status, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
        )
        .run(
          input.captureKey,
          input.taskId,
          input.workflowRef,
          input.wrkfRunId,
          input.bodyHash,
          JSON.stringify(input.evidenceIds),
          JSON.stringify(input.obligationIds),
          now,
          now
        )

      return { state: 'created', record: this.require(input.captureKey) }
    })()
  }

  complete(input: {
    captureKey: string
    evidenceIds: string[]
    obligationIds: string[]
  }): WrkfParticipantCaptureRecord {
    return this.context.sqlite.transaction(() => {
      this.context.sqlite
        .prepare(
          `UPDATE wrkf_participant_captures
              SET status = 'completed',
                  evidence_ids_json = ?,
                  obligation_ids_json = ?,
                  updated_at = ?
            WHERE capture_key = ?`
        )
        .run(
          JSON.stringify(input.evidenceIds),
          JSON.stringify(input.obligationIds),
          new Date().toISOString(),
          input.captureKey
        )

      return this.require(input.captureKey)
    })()
  }

  private require(captureKey: string): WrkfParticipantCaptureRecord {
    const record = this.get(captureKey)
    if (record === undefined) {
      throw new Error(`wrkf participant capture not found: ${captureKey}`)
    }

    return record
  }
}
