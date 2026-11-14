import { randomUUID } from 'node:crypto'
import type { InterfaceIdentity } from 'acp-core'
import { DEFAULT_SYSTEM_ACTOR, serializeMutableActorStamp } from './actor-stamps.js'
import { buildWhereClause } from './sql-filters.js'
import type { SqliteDatabase } from './sqlite.js'

type InterfaceIdentityRow = {
  identity_id: string
  gateway_id: string
  external_id: string
  display_name: string | null
  linked_agent_id: string | null
  created_at: string
  updated_at: string
  actor_stamp: string
}

export interface InterfaceIdentitiesStore {
  register(input: {
    gatewayId: string
    externalId: string
    displayName?: string | undefined
    linkedAgentId?: string | undefined
    now: string
  }): InterfaceIdentity
  list(filters?: {
    gatewayId?: string | undefined
    externalId?: string | undefined
  }): InterfaceIdentity[]
  getByCompositeKey(input: { gatewayId: string; externalId: string }): InterfaceIdentity | undefined
}

const IDENTITY_ID_HEX_LENGTH = 16

function generateIdentityId(): string {
  return `ifid_${randomUUID().replace(/-/g, '').slice(0, IDENTITY_ID_HEX_LENGTH)}`
}

function toInterfaceIdentity(row: InterfaceIdentityRow): InterfaceIdentity {
  return {
    gatewayId: row.gateway_id,
    externalId: row.external_id,
    ...(row.display_name === null ? {} : { displayName: row.display_name }),
    ...(row.linked_agent_id === null ? {} : { linkedAgentId: row.linked_agent_id }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function createInterfaceIdentitiesStore(sqlite: SqliteDatabase): InterfaceIdentitiesStore {
  return {
    register(input) {
      const existing = sqlite
        .prepare(
          `SELECT identity_id, gateway_id, external_id, display_name, linked_agent_id, created_at, updated_at, actor_stamp
           FROM interface_identities
           WHERE gateway_id = ? AND external_id = ?`
        )
        .get(input.gatewayId, input.externalId) as InterfaceIdentityRow | undefined

      if (existing === undefined) {
        const identityId = generateIdentityId()
        sqlite
          .prepare(
            `INSERT INTO interface_identities (
              identity_id,
              gateway_id,
              external_id,
              display_name,
              linked_agent_id,
              created_at,
              updated_at,
              actor_stamp
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            identityId,
            input.gatewayId,
            input.externalId,
            input.displayName ?? null,
            input.linkedAgentId ?? null,
            input.now,
            input.now,
            serializeMutableActorStamp(DEFAULT_SYSTEM_ACTOR, DEFAULT_SYSTEM_ACTOR)
          )

        return this.getByCompositeKey({
          gatewayId: input.gatewayId,
          externalId: input.externalId,
        }) as InterfaceIdentity
      }

      const current = toInterfaceIdentity(existing)
      const nextDisplayName = input.displayName ?? current.displayName
      const nextLinkedAgentId = input.linkedAgentId ?? current.linkedAgentId
      if (current.displayName === nextDisplayName && current.linkedAgentId === nextLinkedAgentId) {
        return current
      }

      sqlite
        .prepare(
          `UPDATE interface_identities
           SET display_name = ?, linked_agent_id = ?, updated_at = ?, actor_stamp = ?
           WHERE identity_id = ?`
        )
        .run(
          nextDisplayName ?? null,
          nextLinkedAgentId ?? null,
          input.now,
          serializeMutableActorStamp(DEFAULT_SYSTEM_ACTOR, DEFAULT_SYSTEM_ACTOR),
          existing.identity_id
        )

      return this.getByCompositeKey({
        gatewayId: input.gatewayId,
        externalId: input.externalId,
      }) as InterfaceIdentity
    },

    list(filters = {}) {
      const { whereClause, values } = buildWhereClause([
        ['gateway_id', '=', filters.gatewayId],
        ['external_id', '=', filters.externalId],
      ])
      return (
        sqlite
          .prepare(
            `SELECT identity_id, gateway_id, external_id, display_name, linked_agent_id, created_at, updated_at, actor_stamp
           FROM interface_identities
           ${whereClause}
           ORDER BY created_at ASC, gateway_id ASC, external_id ASC`
          )
          .all(...values) as InterfaceIdentityRow[]
      ).map(toInterfaceIdentity)
    },

    getByCompositeKey(input) {
      const row = sqlite
        .prepare(
          `SELECT identity_id, gateway_id, external_id, display_name, linked_agent_id, created_at, updated_at, actor_stamp
           FROM interface_identities
           WHERE gateway_id = ? AND external_id = ?`
        )
        .get(input.gatewayId, input.externalId) as InterfaceIdentityRow | undefined

      return row === undefined ? undefined : toInterfaceIdentity(row)
    },
  }
}
