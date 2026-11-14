import type { SystemEvent } from 'acp-core'
import { DEFAULT_SYSTEM_ACTOR, serializeSystemEventActorStamp } from './actor-stamps.js'
import { buildWhereClause } from './sql-filters.js'
import type { SqliteDatabase } from './sqlite.js'

type SystemEventRow = {
  event_id: number | bigint
  project_id: string
  kind: string
  payload: string
  occurred_at: string
  recorded_at: string
  actor_stamp: string
}

export interface SystemEventsStore {
  append(input: {
    projectId: string
    kind: string
    payload: Record<string, unknown>
    occurredAt: string
    recordedAt: string
  }): SystemEvent
  list(filters?: {
    projectId?: string | undefined
    kind?: string | undefined
    occurredAfter?: string | undefined
    occurredBefore?: string | undefined
    /** Monotonic cursor: only events with event_id strictly greater than this.
     * event_id is the autoincrement rowid, so this is a gap-free, no-skip,
     * no-duplicate tail cursor (unlike occurredAt, which can collide). When set,
     * results are ordered by event_id ASC so the caller can advance the cursor to
     * the max event_id returned without skipping same-occurredAt siblings. */
    afterEventId?: string | undefined
    limit?: number | string | undefined
  }): SystemEvent[]
  /** Idempotency guard for observer projections: true if any event of `kind`
   * already carries `payload.<field> === value`. Used to make lifecycle emission
   * exactly-once per (jobRunId, kind) across repeated reconciler ticks and
   * process restarts. */
  existsWithPayloadField(input: { kind: string; field: string; value: string }): boolean
}

function toSystemEvent(row: SystemEventRow): SystemEvent {
  return {
    eventId: String(row.event_id),
    projectId: row.project_id,
    kind: row.kind,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
  }
}

export function createSystemEventsStore(sqlite: SqliteDatabase): SystemEventsStore {
  return {
    append(input) {
      const result = sqlite
        .prepare(
          `INSERT INTO system_events (
            project_id,
            kind,
            payload,
            occurred_at,
            recorded_at,
            actor_stamp
          ) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.projectId,
          input.kind,
          JSON.stringify(input.payload),
          input.occurredAt,
          input.recordedAt,
          serializeSystemEventActorStamp(DEFAULT_SYSTEM_ACTOR)
        )

      const row = sqlite
        .prepare(
          `SELECT event_id, project_id, kind, payload, occurred_at, recorded_at, actor_stamp
           FROM system_events
           WHERE event_id = ?`
        )
        .get(result.lastInsertRowid) as SystemEventRow | undefined

      if (row === undefined) {
        throw new Error('system event insert failed')
      }

      return toSystemEvent(row)
    },

    list(filters) {
      const { whereClause, values } = buildWhereClause([
        ['project_id', '=', filters?.projectId],
        ['kind', '=', filters?.kind],
        ['occurred_at', '>', filters?.occurredAfter],
        ['occurred_at', '<', filters?.occurredBefore],
        ['event_id', '>', filters?.afterEventId],
      ])
      // event_id cursor semantics require event_id ordering so the caller can
      // advance to max(event_id) without skipping same-occurredAt siblings.
      const orderBy =
        filters?.afterEventId !== undefined
          ? 'ORDER BY event_id ASC'
          : 'ORDER BY occurred_at ASC, event_id ASC'
      const limitClause =
        filters?.limit !== undefined && Number.isFinite(Number(filters.limit))
          ? ` LIMIT ${Math.max(0, Math.trunc(Number(filters.limit)))}`
          : ''
      return (
        sqlite
          .prepare(
            `SELECT event_id, project_id, kind, payload, occurred_at, recorded_at, actor_stamp
           FROM system_events
           ${whereClause}
           ${orderBy}${limitClause}`
          )
          .all(...values) as SystemEventRow[]
      ).map(toSystemEvent)
    },

    existsWithPayloadField(input) {
      const row = sqlite
        .prepare(
          `SELECT 1
           FROM system_events
           WHERE kind = ? AND json_extract(payload, ?) = ?
           LIMIT 1`
        )
        .get(input.kind, `$.${input.field}`, input.value)
      return row !== undefined
    },
  }
}
