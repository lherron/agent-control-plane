import type { AgentHeartbeat } from 'acp-core'
import type { AdminStore } from './open-store.js'
import { STALE_HEARTBEAT_THRESHOLD_MS } from './open-store.js'

type ProjectIdRow = {
  project_id: string
}

/**
 * Kind string for the system event emitted when an agent's heartbeat goes stale.
 */
export const STALE_HEARTBEAT_EVENT_KIND = 'agent.heartbeat.stale'

export type StaleHeartbeatCheckResult = {
  staleAgents: AgentHeartbeat[]
  eventsEmitted: number
}

/**
 * Check for agents whose last heartbeat is older than the threshold and emit
 * `agent.heartbeat.stale` system events for each.
 *
 * The threshold defaults to 10 minutes (600_000 ms).
 *
 * Returns the list of stale agents and the count of events emitted.
 */
export function checkStaleHeartbeats(
  store: AdminStore,
  options: {
    now?: Date | undefined
    thresholdMs?: number | undefined
    projectId?: string | undefined
  } = {}
): StaleHeartbeatCheckResult {
  const now = options.now ?? new Date()
  const thresholdMs = options.thresholdMs ?? STALE_HEARTBEAT_THRESHOLD_MS
  const thresholdIso = new Date(now.getTime() - thresholdMs).toISOString()

  const staleAgents = store.heartbeats.listStale(thresholdIso)

  let eventsEmitted = 0
  for (const heartbeat of staleAgents) {
    // Only emit if not already marked stale (avoid duplicate events on repeat checks)
    if (heartbeat.status !== 'stale') {
      // Mark as stale in the heartbeats table
      store.sqlite
        .prepare('UPDATE agent_heartbeats SET status = ? WHERE agent_id = ?')
        .run('stale', heartbeat.agentId)
    }

    // Resolve projectId: use provided, or find from memberships
    let projectId = options.projectId
    if (projectId === undefined) {
      projectId = findFirstProjectIdForAgent(store, heartbeat.agentId)
    }

    if (projectId === undefined) {
      // No project membership found; skip event emission but still mark stale
      continue
    }

    store.systemEvents.append({
      projectId,
      kind: STALE_HEARTBEAT_EVENT_KIND,
      payload: {
        agentId: heartbeat.agentId,
        lastHeartbeatAt: heartbeat.lastHeartbeatAt,
        thresholdMs,
        detectedAt: now.toISOString(),
      },
      occurredAt: now.toISOString(),
      recordedAt: now.toISOString(),
    })
    eventsEmitted += 1
  }

  return { staleAgents, eventsEmitted }
}

function findFirstProjectIdForAgent(store: AdminStore, agentId: string): string | undefined {
  const row = store.sqlite
    .prepare(
      `SELECT p.project_id
       FROM memberships AS m
       INNER JOIN projects AS p ON p.project_id = m.project_id
       WHERE m.agent_id = ?
       ORDER BY p.created_at ASC, p.project_id ASC
       LIMIT 1`
    )
    .get(agentId) as ProjectIdRow | undefined

  return row?.project_id
}
