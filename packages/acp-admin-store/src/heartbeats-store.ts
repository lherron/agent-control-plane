import type { AgentHeartbeat, AgentHeartbeatStatus } from 'acp-core'
import type { SqliteDatabase } from './sqlite.js'

type HeartbeatRow = {
  agent_id: string
  last_heartbeat_at: string
  source: string | null
  last_note: string | null
  status: AgentHeartbeatStatus
  target_scope_ref: string | null
  target_lane_ref: string | null
}

export interface UpsertHeartbeatInput {
  agentId: string
  source?: string | undefined
  note?: string | undefined
  scopeRef?: string | undefined
  laneRef?: string | undefined
  now: string
}

export interface HeartbeatsStore {
  upsert(input: UpsertHeartbeatInput): AgentHeartbeat
  get(agentId: string): AgentHeartbeat | undefined
  list(): AgentHeartbeat[]
  listStale(thresholdIso: string): AgentHeartbeat[]
}

export const STALE_HEARTBEAT_THRESHOLD_MS = 10 * 60 * 1000

function toAgentHeartbeat(row: HeartbeatRow): AgentHeartbeat {
  return {
    agentId: row.agent_id,
    lastHeartbeatAt: row.last_heartbeat_at,
    ...(row.source !== null ? { source: row.source } : {}),
    ...(row.last_note !== null ? { lastNote: row.last_note } : {}),
    status: row.status,
    ...(row.target_scope_ref !== null ? { targetScopeRef: row.target_scope_ref } : {}),
    ...(row.target_lane_ref !== null ? { targetLaneRef: row.target_lane_ref } : {}),
  }
}

const SELECT_RECORD = `SELECT agent_id, last_heartbeat_at, source, last_note, status, target_scope_ref, target_lane_ref
           FROM agent_heartbeats`

export function createHeartbeatsStore(sqlite: SqliteDatabase): HeartbeatsStore {
  return {
    upsert(input) {
      // When scopeRef/laneRef are provided, persist them.
      // When not provided, preserve existing values on update.
      const hasScopeRef = input.scopeRef !== undefined
      const hasLaneRef = input.laneRef !== undefined

      if (hasScopeRef || hasLaneRef) {
        // When scopeRef is set and laneRef is not, default laneRef to 'main'
        const effectiveLaneRef = input.laneRef ?? (hasScopeRef ? 'main' : null)
        sqlite
          .prepare(
            `INSERT INTO agent_heartbeats (
              agent_id,
              last_heartbeat_at,
              source,
              last_note,
              status,
              target_scope_ref,
              target_lane_ref
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (agent_id) DO UPDATE SET
              last_heartbeat_at = excluded.last_heartbeat_at,
              source = excluded.source,
              last_note = excluded.last_note,
              status = excluded.status,
              target_scope_ref = COALESCE(excluded.target_scope_ref, agent_heartbeats.target_scope_ref),
              target_lane_ref = COALESCE(excluded.target_lane_ref, agent_heartbeats.target_lane_ref)`
          )
          .run(
            input.agentId,
            input.now,
            input.source ?? null,
            input.note ?? null,
            'alive' satisfies AgentHeartbeatStatus,
            input.scopeRef ?? null,
            effectiveLaneRef
          )
      } else {
        sqlite
          .prepare(
            `INSERT INTO agent_heartbeats (
              agent_id,
              last_heartbeat_at,
              source,
              last_note,
              status
            ) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (agent_id) DO UPDATE SET
              last_heartbeat_at = excluded.last_heartbeat_at,
              source = excluded.source,
              last_note = excluded.last_note,
              status = excluded.status`
          )
          .run(
            input.agentId,
            input.now,
            input.source ?? null,
            input.note ?? null,
            'alive' satisfies AgentHeartbeatStatus
          )
      }

      return this.get(input.agentId) as AgentHeartbeat
    },

    get(agentId) {
      const row = sqlite
        .prepare(
          `${SELECT_RECORD}
           WHERE agent_id = ?`
        )
        .get(agentId) as HeartbeatRow | undefined

      return row === undefined ? undefined : toAgentHeartbeat(row)
    },

    list() {
      return (
        sqlite
          .prepare(
            `${SELECT_RECORD}
           ORDER BY last_heartbeat_at DESC, agent_id ASC`
          )
          .all() as HeartbeatRow[]
      ).map(toAgentHeartbeat)
    },

    listStale(thresholdIso) {
      return (
        sqlite
          .prepare(
            `${SELECT_RECORD}
           WHERE last_heartbeat_at < ?
           ORDER BY last_heartbeat_at ASC, agent_id ASC`
          )
          .all(thresholdIso) as HeartbeatRow[]
      ).map(toAgentHeartbeat)
    },
  }
}
