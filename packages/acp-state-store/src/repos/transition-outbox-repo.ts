import type { Actor } from 'acp-core'

import type {
  AppendTransitionOutboxInput,
  TransitionOutboxRecord,
  TransitionOutboxStatus,
} from '../types.js'
import type { RepoContext } from './shared.js'
import { DEFAULT_SYSTEM_ACTOR, parseJsonRecord } from './shared.js'

type TransitionOutboxRow = {
  transition_event_id: string
  task_id: string
  project_id: string
  from_phase: string
  to_phase: string
  actor_kind: Actor['kind']
  actor_id: string
  actor_display_name: string | null
  payload_json: string
  status: TransitionOutboxStatus
  leased_at: string | null
  delivered_at: string | null
  attempts: number
  last_error: string | null
  created_at: string
}

/**
 * Column projection for `transition_outbox` SELECTs, in the order
 * {@link TransitionOutboxRow} reads them. Single source so the `leaseNext` and
 * `get` queries cannot drift apart.
 */
const TRANSITION_OUTBOX_COLUMNS = `transition_event_id,
        task_id,
        project_id,
        from_phase,
        to_phase,
        actor_kind,
        actor_id,
        actor_display_name,
        payload_json,
        status,
        leased_at,
        delivered_at,
        attempts,
        last_error,
        created_at`

function mapTransitionOutboxRow(row: TransitionOutboxRow): TransitionOutboxRecord {
  return {
    transitionEventId: row.transition_event_id,
    taskId: row.task_id,
    projectId: row.project_id,
    fromPhase: row.from_phase,
    toPhase: row.to_phase,
    actor: {
      kind: row.actor_kind,
      id: row.actor_id,
      ...(row.actor_display_name !== null ? { displayName: row.actor_display_name } : {}),
    },
    payload: parseJsonRecord(row.payload_json) ?? {},
    status: row.status,
    ...(row.leased_at !== null ? { leasedAt: row.leased_at } : {}),
    ...(row.delivered_at !== null ? { deliveredAt: row.delivered_at } : {}),
    attempts: row.attempts,
    lastError: row.last_error,
    createdAt: row.created_at,
  }
}

export class TransitionOutboxRepo {
  constructor(private readonly context: RepoContext) {}

  append(input: AppendTransitionOutboxInput): TransitionOutboxRecord {
    return this.context.sqlite.transaction(() => {
      const actor = input.actor ?? DEFAULT_SYSTEM_ACTOR
      this.context.sqlite
        .prepare(
          `INSERT OR IGNORE INTO transition_outbox (
             transition_event_id,
             task_id,
             project_id,
             from_phase,
             to_phase,
             actor_kind,
             actor_id,
             actor_display_name,
             payload_json,
             status,
             leased_at,
             delivered_at,
             attempts,
             last_error,
             created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, 0, NULL, ?)`
        )
        .run(
          input.transitionEventId,
          input.taskId,
          input.projectId,
          input.fromPhase,
          input.toPhase,
          actor.kind,
          actor.id,
          actor.displayName ?? null,
          JSON.stringify(input.payload),
          new Date().toISOString()
        )

      return this.require(input.transitionEventId)
    })()
  }

  leaseNext(): TransitionOutboxRecord | undefined {
    return this.context.sqlite.transaction(() => {
      const next = this.context.sqlite
        .prepare(
          `SELECT ${TRANSITION_OUTBOX_COLUMNS}
             FROM transition_outbox
            WHERE status IN ('pending', 'leased')
         ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END ASC,
                  COALESCE(leased_at, created_at) ASC,
                  created_at ASC,
                  transition_event_id ASC
            LIMIT 1`
        )
        .get() as TransitionOutboxRow | undefined

      if (next === undefined) {
        return undefined
      }

      this.context.sqlite
        .prepare(
          `UPDATE transition_outbox
              SET status = 'leased',
                  leased_at = ?,
                  attempts = attempts + 1,
                  last_error = NULL
            WHERE transition_event_id = ?
              AND status != 'delivered'`
        )
        .run(new Date().toISOString(), next.transition_event_id)

      return this.require(next.transition_event_id)
    })()
  }

  markErrored(transitionEventId: string, error: string): TransitionOutboxRecord | undefined {
    return this.context.sqlite.transaction(() => {
      this.context.sqlite
        .prepare(
          `UPDATE transition_outbox
              SET status = 'leased',
                  last_error = ?
            WHERE transition_event_id = ?`
        )
        .run(error, transitionEventId)

      return this.get(transitionEventId)
    })()
  }

  markDelivered(transitionEventId: string): TransitionOutboxRecord | undefined {
    return this.context.sqlite.transaction(() => {
      this.context.sqlite
        .prepare(
          `UPDATE transition_outbox
              SET status = 'delivered',
                  delivered_at = ?,
                  last_error = NULL
            WHERE transition_event_id = ?`
        )
        .run(new Date().toISOString(), transitionEventId)

      return this.get(transitionEventId)
    })()
  }

  get(transitionEventId: string): TransitionOutboxRecord | undefined {
    const row = this.context.sqlite
      .prepare(
        `SELECT ${TRANSITION_OUTBOX_COLUMNS}
           FROM transition_outbox
          WHERE transition_event_id = ?`
      )
      .get(transitionEventId) as TransitionOutboxRow | undefined

    return row === undefined ? undefined : mapTransitionOutboxRow(row)
  }

  private require(transitionEventId: string): TransitionOutboxRecord {
    const row = this.get(transitionEventId)
    if (row === undefined) {
      throw new Error(`transition outbox event not found: ${transitionEventId}`)
    }

    return row
  }
}
