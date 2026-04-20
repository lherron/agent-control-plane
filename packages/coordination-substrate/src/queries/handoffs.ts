import type { SQLQueryBindings } from 'bun:sqlite'
import type { SessionRef } from 'agent-scope'

import type { CoordinationStore } from '../storage/open-store.js'
import { type HandoffRow, hydrateHandoff } from '../storage/records.js'
import type { Handoff } from '../types/handoff.js'
import type { ParticipantRef } from '../types/participant-ref.js'
import { stableStringify } from '../util/json.js'
import { formatCanonicalSessionRef } from '../util/session-ref.js'

export type OpenHandoffQuery = {
  projectId: string
  taskId?: string | undefined
  toParticipant?: ParticipantRef | undefined
  targetSession?: SessionRef | undefined
}

export function listOpenHandoffs(store: CoordinationStore, query: OpenHandoffQuery): Handoff[] {
  const conditions = ['project_id = ?', 'state = ?']
  const parameters: SQLQueryBindings[] = [query.projectId, 'open']

  if (query.taskId !== undefined) {
    conditions.push('task_id = ?')
    parameters.push(query.taskId)
  }

  if (query.toParticipant !== undefined) {
    conditions.push('to_participant = ?')
    parameters.push(stableStringify(query.toParticipant))
  }

  if (query.targetSession !== undefined) {
    conditions.push('target_session = ?')
    parameters.push(formatCanonicalSessionRef(query.targetSession))
  }

  const rows = store.sqlite
    .query<HandoffRow, SQLQueryBindings[]>(
      `SELECT * FROM handoffs WHERE ${conditions.join(' AND ')} ORDER BY created_at ASC, handoff_id ASC`
    )
    .all(...parameters)

  return rows.map((row) => hydrateHandoff(row))
}
