import type { InputQueueItem, InputQueueStatus } from 'acp-core'

import type { InputQueueCreateInput, InputQueueUpdateInput } from '../types.js'
import type { RepoContext } from './shared.js'
import { shortId } from './shared.js'

/** Default cap on rows returned by `listDispatchable`. */
const DEFAULT_DISPATCHABLE_LIMIT = 50
/** Default cap on session heads returned by `listDispatchableSessionHeads`. */
const DEFAULT_DISPATCHABLE_SESSION_HEADS_LIMIT = 200

type InputQueueRow = {
  queue_item_id: string
  input_attempt_id: string
  run_id: string
  scope_ref: string
  lane_ref: string
  seq: number
  status: InputQueueStatus
  reset_policy: InputQueueItem['resetPolicy']
  expected_host_session_id: string | null
  expected_generation: number | null
  not_before_at: string | null
  leased_at: string | null
  lease_owner: string | null
  attempts: number
  last_error_code: string | null
  last_error_message: string | null
  created_at: string
  updated_at: string
}

/**
 * Column projection for `input_queue` SELECTs, in the order
 * {@link InputQueueRow} reads them. Single source so the per-query
 * SELECTs cannot drift apart.
 */
const INPUT_QUEUE_SELECT_SQL = `SELECT queue_item_id,
                   input_attempt_id,
                   run_id,
                   scope_ref,
                   lane_ref,
                   seq,
                   status,
                   reset_policy,
                   expected_host_session_id,
                   expected_generation,
                   not_before_at,
                   leased_at,
                   lease_owner,
                   attempts,
                   last_error_code,
                   last_error_message,
                   created_at,
                   updated_at
              FROM input_queue`

function mapRow(row: InputQueueRow): InputQueueItem {
  return {
    queueItemId: row.queue_item_id,
    inputAttemptId: row.input_attempt_id,
    runId: row.run_id,
    scopeRef: row.scope_ref,
    laneRef: row.lane_ref,
    seq: row.seq,
    status: row.status,
    resetPolicy: row.reset_policy,
    ...(row.expected_host_session_id !== null
      ? { expectedHostSessionId: row.expected_host_session_id }
      : {}),
    ...(row.expected_generation !== null ? { expectedGeneration: row.expected_generation } : {}),
    ...(row.not_before_at !== null ? { notBeforeAt: row.not_before_at } : {}),
    ...(row.leased_at !== null ? { leasedAt: row.leased_at } : {}),
    ...(row.lease_owner !== null ? { leaseOwner: row.lease_owner } : {}),
    attempts: row.attempts,
    ...(row.last_error_code !== null ? { lastErrorCode: row.last_error_code } : {}),
    ...(row.last_error_message !== null ? { lastErrorMessage: row.last_error_message } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class InputQueueRepo {
  constructor(private readonly context: RepoContext) {}

  create(input: InputQueueCreateInput): InputQueueItem {
    const now = new Date().toISOString()
    const queueItemId = shortId('iq_')
    this.context.sqlite
      .prepare(
        `INSERT INTO input_queue (
           queue_item_id,
           input_attempt_id,
           run_id,
           scope_ref,
           lane_ref,
           seq,
           status,
           reset_policy,
           expected_host_session_id,
           expected_generation,
           not_before_at,
           attempts,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        queueItemId,
        input.inputAttemptId,
        input.runId,
        input.scopeRef,
        input.laneRef,
        input.seq,
        input.status ?? 'queued',
        input.resetPolicy ?? 'follow_latest',
        input.expectedHostSessionId ?? null,
        input.expectedGeneration ?? null,
        input.notBeforeAt ?? null,
        0,
        now,
        now
      )

    return this.require(queueItemId)
  }

  getById(queueItemId: string): InputQueueItem | undefined {
    const row = this.context.sqlite
      .prepare(`${INPUT_QUEUE_SELECT_SQL} WHERE queue_item_id = ?`)
      .get(queueItemId) as InputQueueRow | undefined

    return row === undefined ? undefined : mapRow(row)
  }

  getByRunId(runId: string): InputQueueItem | undefined {
    const row = this.context.sqlite
      .prepare(`${INPUT_QUEUE_SELECT_SQL} WHERE run_id = ?`)
      .get(runId) as InputQueueRow | undefined

    return row === undefined ? undefined : mapRow(row)
  }

  listDispatchable(limit = DEFAULT_DISPATCHABLE_LIMIT): readonly InputQueueItem[] {
    const now = new Date().toISOString()
    const rows = this.context.sqlite
      .prepare(
        `${INPUT_QUEUE_SELECT_SQL}
          WHERE status = 'queued'
            AND (not_before_at IS NULL OR not_before_at <= ?)
       ORDER BY scope_ref ASC, lane_ref ASC, seq ASC
          LIMIT ?`
      )
      .all(now, limit) as InputQueueRow[]

    return rows.map((row) => mapRow(row))
  }

  listDispatchableSessionHeads(
    limit = DEFAULT_DISPATCHABLE_SESSION_HEADS_LIMIT
  ): readonly InputQueueItem[] {
    const now = new Date().toISOString()
    const rows = this.context.sqlite
      .prepare(
        `${INPUT_QUEUE_SELECT_SQL}
          WHERE status = 'queued'
            AND (not_before_at IS NULL OR not_before_at <= ?)
            AND seq = (
              SELECT MIN(iq_inner.seq)
                FROM input_queue iq_inner
                WHERE iq_inner.scope_ref = input_queue.scope_ref
                  AND iq_inner.lane_ref = input_queue.lane_ref
                  AND iq_inner.status = 'queued'
                  AND (iq_inner.not_before_at IS NULL OR iq_inner.not_before_at <= ?)
            )
       ORDER BY scope_ref ASC, lane_ref ASC
          LIMIT ?`
      )
      .all(now, now, limit) as InputQueueRow[]

    return rows.map((row) => mapRow(row))
  }

  getHead(scopeRef: string, laneRef: string): InputQueueItem | undefined {
    const row = this.context.sqlite
      .prepare(
        `${INPUT_QUEUE_SELECT_SQL}
          WHERE scope_ref = ?
            AND lane_ref = ?
            AND status IN ('queued', 'leased', 'dispatching')
       ORDER BY seq ASC
          LIMIT 1`
      )
      .get(scopeRef, laneRef) as InputQueueRow | undefined

    return row === undefined ? undefined : mapRow(row)
  }

  listForSession(scopeRef: string, laneRef: string): readonly InputQueueItem[] {
    const rows = this.context.sqlite
      .prepare(
        `${INPUT_QUEUE_SELECT_SQL}
          WHERE scope_ref = ?
            AND lane_ref = ?
       ORDER BY seq ASC`
      )
      .all(scopeRef, laneRef) as InputQueueRow[]

    return rows.map((row) => mapRow(row))
  }

  update(queueItemId: string, patch: InputQueueUpdateInput): InputQueueItem {
    const current = this.require(queueItemId)
    const now = new Date().toISOString()
    this.context.sqlite
      .prepare(
        `UPDATE input_queue
            SET status = ?,
                not_before_at = ?,
                leased_at = ?,
                lease_owner = ?,
                attempts = ?,
                last_error_code = ?,
                last_error_message = ?,
                updated_at = ?
          WHERE queue_item_id = ?`
      )
      .run(
        patch.status ?? current.status,
        patch.notBeforeAt ?? current.notBeforeAt ?? null,
        patch.leasedAt ?? current.leasedAt ?? null,
        patch.leaseOwner ?? current.leaseOwner ?? null,
        patch.attempts ?? current.attempts,
        patch.lastErrorCode ?? current.lastErrorCode ?? null,
        patch.lastErrorMessage ?? current.lastErrorMessage ?? null,
        now,
        queueItemId
      )

    return this.require(queueItemId)
  }

  private require(queueItemId: string): InputQueueItem {
    const item = this.getById(queueItemId)
    if (item === undefined) {
      throw new Error(`input queue item not found: ${queueItemId}`)
    }
    return item
  }
}
