import type { SQLQueryBindings } from 'bun:sqlite'

import type { CoordinationStore } from '../storage/open-store.js'
import { parseJson } from '../util/json.js'

export type CoordinationEventLinkRecord = {
  eventId: string
  projectId: string
  seq: number
  taskId?: string | undefined
  runId?: string | undefined
  sessionId?: string | undefined
  deliveryRequestId?: string | undefined
  artifactRefs?: string[] | undefined
  conversationThreadId?: string | undefined
  conversationTurnId?: string | undefined
}

type CoordinationEventLinkRow = {
  event_id: string
  project_id: string
  seq: number
  task_id: string | null
  run_id: string | null
  session_id: string | null
  delivery_request_id: string | null
  artifact_refs: string | null
  conversation_thread_id: string | null
  conversation_turn_id: string | null
}

export type EventLinkQuery = {
  projectId: string
  taskId?: string | undefined
  runId?: string | undefined
  sessionId?: string | undefined
  conversationThreadId?: string | undefined
}

export function listEventLinks(
  store: CoordinationStore,
  query: EventLinkQuery
): CoordinationEventLinkRecord[] {
  const conditions = ['l.project_id = ?']
  const parameters: SQLQueryBindings[] = [query.projectId]

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

  const rows = store.sqlite
    .query<CoordinationEventLinkRow, SQLQueryBindings[]>(
      `
        SELECT
          l.event_id,
          l.project_id,
          e.seq,
          l.task_id,
          l.run_id,
          l.session_id,
          l.delivery_request_id,
          l.artifact_refs,
          l.conversation_thread_id,
          l.conversation_turn_id
        FROM coordination_event_links l
        INNER JOIN coordination_events e ON e.event_id = l.event_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY e.seq ASC
      `
    )
    .all(...parameters)

  return rows.map((row) => ({
    eventId: row.event_id,
    projectId: row.project_id,
    seq: row.seq,
    taskId: row.task_id ?? undefined,
    runId: row.run_id ?? undefined,
    sessionId: row.session_id ?? undefined,
    deliveryRequestId: row.delivery_request_id ?? undefined,
    artifactRefs: parseJson<string[]>(row.artifact_refs),
    conversationThreadId: row.conversation_thread_id ?? undefined,
    conversationTurnId: row.conversation_turn_id ?? undefined,
  }))
}
