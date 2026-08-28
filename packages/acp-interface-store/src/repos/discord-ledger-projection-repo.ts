import type {
  DiscordLedgerProjectionRoute,
  RecordDiscordLedgerProjectionRouteInput,
} from '../types.js'
import type { RepoContext } from './shared.js'
import { toOptionalString } from './shared.js'

type RouteRow = {
  gateway_id: string
  room_uuid: string
  room_key: string
  binding_id: string
  conversation_ref: string
  thread_ref: string | null
  human_principal_ref: string
  updated_at: string
}

function mapRoute(row: RouteRow): DiscordLedgerProjectionRoute {
  return {
    gatewayId: row.gateway_id,
    roomUuid: row.room_uuid,
    roomKey: row.room_key,
    bindingId: row.binding_id,
    conversationRef: row.conversation_ref,
    threadRef: toOptionalString(row.thread_ref),
    humanPrincipalRef: row.human_principal_ref,
    updatedAt: row.updated_at,
  }
}

/** Durable observer state for Discord's wrkq-ledger egress projection. */
export class DiscordLedgerProjectionRepo {
  constructor(private readonly context: RepoContext) {}

  getCursor(gatewayId: string): number | undefined {
    const row = this.context.sqlite
      .prepare(
        `SELECT high_water
           FROM discord_ledger_projection_cursors
          WHERE gateway_id = ?`
      )
      .get(gatewayId) as { high_water: number } | undefined
    return row?.high_water
  }

  advanceCursor(gatewayId: string, highWater: number): number {
    this.context.sqlite
      .prepare(
        `INSERT INTO discord_ledger_projection_cursors (gateway_id, high_water, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(gateway_id) DO UPDATE SET
           high_water = MAX(discord_ledger_projection_cursors.high_water, excluded.high_water),
           updated_at = excluded.updated_at`
      )
      .run(gatewayId, highWater, new Date().toISOString())
    return this.getCursor(gatewayId) ?? highWater
  }

  recordRoute(input: RecordDiscordLedgerProjectionRouteInput): DiscordLedgerProjectionRoute {
    const updatedAt = new Date().toISOString()
    this.context.sqlite
      .prepare(
        `INSERT INTO discord_ledger_projection_routes (
           gateway_id, room_uuid, room_key, binding_id, conversation_ref,
           thread_ref, human_principal_ref, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(gateway_id, room_uuid) DO UPDATE SET
           room_key = excluded.room_key,
           binding_id = excluded.binding_id,
           conversation_ref = excluded.conversation_ref,
           thread_ref = excluded.thread_ref,
           human_principal_ref = excluded.human_principal_ref,
           updated_at = excluded.updated_at`
      )
      .run(
        input.gatewayId,
        input.roomUuid,
        input.roomKey,
        input.bindingId,
        input.conversationRef,
        input.threadRef ?? null,
        input.humanPrincipalRef,
        updatedAt
      )
    return this.requireRoute(input.gatewayId, input.roomUuid)
  }

  getRoute(gatewayId: string, roomUuid: string): DiscordLedgerProjectionRoute | undefined {
    const row = this.context.sqlite
      .prepare(
        `SELECT gateway_id, room_uuid, room_key, binding_id, conversation_ref,
                thread_ref, human_principal_ref, updated_at
           FROM discord_ledger_projection_routes
          WHERE gateway_id = ? AND room_uuid = ?`
      )
      .get(gatewayId, roomUuid) as RouteRow | undefined
    return row === undefined ? undefined : mapRoute(row)
  }

  pruneBindings(gatewayId: string, activeBindingIds: readonly string[]): number {
    if (activeBindingIds.length === 0) {
      return this.context.sqlite
        .prepare('DELETE FROM discord_ledger_projection_routes WHERE gateway_id = ?')
        .run(gatewayId).changes
    }
    const placeholders = activeBindingIds.map(() => '?').join(', ')
    return this.context.sqlite
      .prepare(
        `DELETE FROM discord_ledger_projection_routes
          WHERE gateway_id = ? AND binding_id NOT IN (${placeholders})`
      )
      .run(gatewayId, ...activeBindingIds).changes
  }

  private requireRoute(gatewayId: string, roomUuid: string): DiscordLedgerProjectionRoute {
    const route = this.getRoute(gatewayId, roomUuid)
    if (route === undefined) {
      throw new Error(`Failed to reload Discord ledger route ${gatewayId}:${roomUuid}`)
    }
    return route
  }
}
