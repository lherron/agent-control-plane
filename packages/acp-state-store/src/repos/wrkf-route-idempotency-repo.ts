import type { RepoContext } from './shared.js'

export type WrkfRouteIdempotencyStatus = 'pending' | 'completed' | 'failed'

export type WrkfRouteIdempotencyRecord = {
  route: string
  taskId: string
  actorHash: string
  idempotencyKey: string
  bodyHash: string
  status: WrkfRouteIdempotencyStatus
  responseJson?: unknown
  errorJson?: unknown
  createdAt: string
  updatedAt: string
}

export type WrkfRouteIdempotencyKey = {
  route: string
  taskId: string
  actorHash: string
  idempotencyKey: string
}

export type WrkfRouteAdmitResult =
  | { state: 'admitted' }
  | { state: 'replay'; record: WrkfRouteIdempotencyRecord }
  | { state: 'conflict' }

type WrkfRouteIdempotencyRow = {
  route: string
  task_id: string
  actor_hash: string
  idempotency_key: string
  body_hash: string
  status: WrkfRouteIdempotencyStatus
  response_json: string | null
  error_json: string | null
  created_at: string
  updated_at: string
}

function mapRow(row: WrkfRouteIdempotencyRow): WrkfRouteIdempotencyRecord {
  return {
    route: row.route,
    taskId: row.task_id,
    actorHash: row.actor_hash,
    idempotencyKey: row.idempotency_key,
    bodyHash: row.body_hash,
    status: row.status,
    ...(row.response_json !== null
      ? { responseJson: JSON.parse(row.response_json) as unknown }
      : {}),
    ...(row.error_json !== null ? { errorJson: JSON.parse(row.error_json) as unknown } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class WrkfRouteIdempotencyRepo {
  constructor(private readonly context: RepoContext) {}

  get(input: WrkfRouteIdempotencyKey): WrkfRouteIdempotencyRecord | undefined {
    const row = this.context.sqlite
      .prepare(
        `SELECT route, task_id, actor_hash, idempotency_key, body_hash, status,
                response_json, error_json, created_at, updated_at
           FROM wrkf_route_idempotency
          WHERE route = ? AND task_id = ? AND actor_hash = ? AND idempotency_key = ?`
      )
      .get(input.route, input.taskId, input.actorHash, input.idempotencyKey) as
      | WrkfRouteIdempotencyRow
      | undefined

    return row === undefined ? undefined : mapRow(row)
  }

  admitOrReplay(input: WrkfRouteIdempotencyKey & { bodyHash: string }): WrkfRouteAdmitResult {
    return this.context.sqlite.transaction((): WrkfRouteAdmitResult => {
      const existing = this.get(input)
      if (existing !== undefined) {
        if (existing.bodyHash !== input.bodyHash) {
          return { state: 'conflict' }
        }
        return { state: 'replay', record: existing }
      }

      const now = new Date().toISOString()
      this.context.sqlite
        .prepare(
          `INSERT INTO wrkf_route_idempotency (
             route, task_id, actor_hash, idempotency_key, body_hash, status,
             response_json, error_json, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?)`
        )
        .run(
          input.route,
          input.taskId,
          input.actorHash,
          input.idempotencyKey,
          input.bodyHash,
          now,
          now
        )

      return { state: 'admitted' }
    })()
  }

  recordResponse(
    input: WrkfRouteIdempotencyKey & { responseJson: unknown }
  ): WrkfRouteIdempotencyRecord {
    return this.context.sqlite.transaction(() => {
      this.context.sqlite
        .prepare(
          `UPDATE wrkf_route_idempotency
              SET status = 'completed',
                  response_json = ?,
                  error_json = NULL,
                  updated_at = ?
            WHERE route = ? AND task_id = ? AND actor_hash = ? AND idempotency_key = ?`
        )
        .run(
          JSON.stringify(input.responseJson),
          new Date().toISOString(),
          input.route,
          input.taskId,
          input.actorHash,
          input.idempotencyKey
        )

      return this.require(input)
    })()
  }

  recordError(input: WrkfRouteIdempotencyKey & { errorJson: unknown }): WrkfRouteIdempotencyRecord {
    return this.context.sqlite.transaction(() => {
      this.context.sqlite
        .prepare(
          `UPDATE wrkf_route_idempotency
              SET status = 'failed',
                  error_json = ?,
                  updated_at = ?
            WHERE route = ? AND task_id = ? AND actor_hash = ? AND idempotency_key = ?`
        )
        .run(
          JSON.stringify(input.errorJson),
          new Date().toISOString(),
          input.route,
          input.taskId,
          input.actorHash,
          input.idempotencyKey
        )

      return this.require(input)
    })()
  }

  private require(input: WrkfRouteIdempotencyKey): WrkfRouteIdempotencyRecord {
    const record = this.get(input)
    if (record === undefined) {
      throw new Error(
        `wrkf route idempotency record not found: ${input.route}/${input.taskId}/${input.actorHash}/${input.idempotencyKey}`
      )
    }

    return record
  }
}
