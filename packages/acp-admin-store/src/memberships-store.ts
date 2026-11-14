import type { Actor, AdminMembership, MembershipRole } from 'acp-core'
import {
  type ImmutableActorStamp,
  sameActor,
  serializeImmutableActorStamp,
} from './actor-stamps.js'
import type { SqliteDatabase } from './sqlite.js'

type MembershipRow = {
  project_id: string
  agent_id: string
  role: MembershipRole
  created_at: string
  actor_stamp: string
}

export interface MembershipsStore {
  add(input: {
    projectId: string
    agentId: string
    role: MembershipRole
    actor: Actor
    now: string
  }): AdminMembership
  listByProject(projectId: string): AdminMembership[]
}

function toAdminMembership(row: MembershipRow): AdminMembership {
  const stamp = JSON.parse(row.actor_stamp) as ImmutableActorStamp
  return {
    projectId: row.project_id,
    agentId: row.agent_id,
    role: row.role,
    createdAt: row.created_at,
    createdBy: stamp.createdBy,
  }
}

export function createMembershipsStore(sqlite: SqliteDatabase): MembershipsStore {
  return {
    add(input) {
      const existing = sqlite
        .prepare(
          `SELECT project_id, agent_id, role, created_at, actor_stamp
           FROM memberships
           WHERE project_id = ? AND agent_id = ?`
        )
        .get(input.projectId, input.agentId) as MembershipRow | undefined

      if (existing !== undefined) {
        const membership = toAdminMembership(existing)
        if (membership.role === input.role && sameActor(membership.createdBy, input.actor)) {
          return membership
        }

        throw new Error(
          `membership ${input.projectId}/${input.agentId} already exists with different values`
        )
      }

      sqlite
        .prepare(
          `INSERT INTO memberships (project_id, agent_id, role, created_at, actor_stamp)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(
          input.projectId,
          input.agentId,
          input.role,
          input.now,
          serializeImmutableActorStamp(input.actor)
        )

      const row = sqlite
        .prepare(
          `SELECT project_id, agent_id, role, created_at, actor_stamp
           FROM memberships
           WHERE project_id = ? AND agent_id = ?`
        )
        .get(input.projectId, input.agentId) as MembershipRow | undefined

      if (row === undefined) {
        throw new Error('membership insert failed')
      }

      return toAdminMembership(row)
    },

    listByProject(projectId) {
      return (
        sqlite
          .prepare(
            `SELECT project_id, agent_id, role, created_at, actor_stamp
           FROM memberships
           WHERE project_id = ?
           ORDER BY created_at ASC, agent_id ASC`
          )
          .all(projectId) as MembershipRow[]
      ).map(toAdminMembership)
    },
  }
}
