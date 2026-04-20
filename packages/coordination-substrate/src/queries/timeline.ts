import type { SQLQueryBindings } from 'bun:sqlite'
import type { SessionRef } from 'agent-scope'

import type { CoordinationStore } from '../storage/open-store.js'
import {
  type CoordinationEventJoinedRow,
  hydrateCoordinationEvent,
  listParticipantsForEvent,
} from '../storage/records.js'
import type { CoordinationEvent } from '../types/coordination-event.js'
import type { ParticipantRef } from '../types/participant-ref.js'
import { stableStringify } from '../util/json.js'
import { formatCanonicalSessionRef } from '../util/session-ref.js'

export type TimelineQuery = {
  projectId: string
  fromSeq?: number | undefined
  toSeq?: number | undefined
  sessionRef?: SessionRef | undefined
  taskId?: string | undefined
  runId?: string | undefined
  sessionId?: string | undefined
  conversationThreadId?: string | undefined
  participant?: ParticipantRef | undefined
  limit?: number | undefined
}

export function listEvents(store: CoordinationStore, query: TimelineQuery): CoordinationEvent[] {
  const conditions = ['e.project_id = ?']
  const parameters: SQLQueryBindings[] = [query.projectId]

  if (query.fromSeq !== undefined) {
    conditions.push('e.seq >= ?')
    parameters.push(query.fromSeq)
  }

  if (query.toSeq !== undefined) {
    conditions.push('e.seq <= ?')
    parameters.push(query.toSeq)
  }

  if (query.sessionRef !== undefined) {
    conditions.push('e.semantic_session = ?')
    parameters.push(formatCanonicalSessionRef(query.sessionRef))
  }

  if (query.taskId !== undefined) {
    conditions.push('l.task_id = ?')
    parameters.push(query.taskId)
  }

  if (query.runId !== undefined) {
    conditions.push('l.run_id = ?')
    parameters.push(query.runId)
  }

  if (query.sessionId !== undefined) {
    conditions.push('l.session_id = ?')
    parameters.push(query.sessionId)
  }

  if (query.conversationThreadId !== undefined) {
    conditions.push('l.conversation_thread_id = ?')
    parameters.push(query.conversationThreadId)
  }

  if (query.participant !== undefined) {
    conditions.push(
      'EXISTS (SELECT 1 FROM coordination_event_participants p WHERE p.event_id = e.event_id AND p.participant = ?)'
    )
    parameters.push(stableStringify(query.participant))
  }

  let sql = `
    SELECT
      e.event_id,
      e.project_id,
      e.seq,
      e.ts,
      e.kind,
      e.actor,
      e.semantic_session,
      e.content,
      e.source,
      e.meta,
      e.idempotency_key,
      l.event_id,
      l.project_id,
      l.task_id,
      l.run_id,
      l.session_id,
      l.delivery_request_id,
      l.artifact_refs,
      l.conversation_thread_id,
      l.conversation_turn_id
    FROM coordination_events e
    LEFT JOIN coordination_event_links l ON l.event_id = e.event_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY e.seq ASC
  `

  if (query.limit !== undefined) {
    sql += ' LIMIT ?'
    parameters.push(query.limit)
  }

  const rows = store.sqlite
    .query<CoordinationEventJoinedRow, SQLQueryBindings[]>(sql)
    .all(...parameters)
  return rows.map((row) =>
    hydrateCoordinationEvent(row, listParticipantsForEvent(store.sqlite, row.event_id))
  )
}
