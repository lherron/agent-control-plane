import type { Database } from 'bun:sqlite'

import type {
  CoordinationEvent,
  CoordinationEventContent,
  CoordinationEventLinks,
  CoordinationEventSource,
} from '../types/coordination-event.js'
import type { Handoff } from '../types/handoff.js'
import type { LocalDispatchAttempt } from '../types/local-dispatch-attempt.js'
import type { ParticipantRef } from '../types/participant-ref.js'
import type { WakeRequest } from '../types/wake-request.js'
import { parseJson } from '../util/json.js'
import { parseCanonicalSessionRef } from '../util/session-ref.js'

export type CoordinationEventRow = {
  event_id: string
  project_id: string
  seq: number
  ts: string
  kind: CoordinationEvent['kind']
  actor: string | null
  semantic_session: string | null
  content: string | null
  source: string | null
  meta: string | null
  idempotency_key: string | null
}

export type CoordinationEventLinkRow = {
  event_id: string
  project_id: string
  task_id: string | null
  run_id: string | null
  session_id: string | null
  delivery_request_id: string | null
  artifact_refs: string | null
  conversation_thread_id: string | null
  conversation_turn_id: string | null
}

export type CoordinationEventJoinedRow = CoordinationEventRow & CoordinationEventLinkRow

export type HandoffRow = {
  handoff_id: string
  project_id: string
  source_event_id: string
  task_id: string | null
  from_participant: string | null
  to_participant: string | null
  target_session: string | null
  kind: Handoff['kind']
  reason: string | null
  state: Handoff['state']
  created_at: string
  updated_at: string
}

export type WakeRequestRow = {
  wake_id: string
  project_id: string
  source_event_id: string
  session_ref: string
  reason: string | null
  dedupe_key: string | null
  state: WakeRequest['state']
  leased_until: string | null
  created_at: string
  updated_at: string
}

export type LocalDispatchAttemptRow = {
  attempt_id: string
  wake_id: string | null
  target: string
  state: string
  created_at: string
  updated_at: string
}

type ParticipantRow = {
  participant: string
}

type EventIdRow = {
  event_id: string
}

export function listParticipantsForEvent(sqlite: Database, eventId: string): ParticipantRef[] {
  return sqlite
    .query<ParticipantRow, [string]>(
      'SELECT participant FROM coordination_event_participants WHERE event_id = ? ORDER BY participant ASC'
    )
    .all(eventId)
    .map((row) => JSON.parse(row.participant) as ParticipantRef)
}

export function hydrateCoordinationEvent(
  row: CoordinationEventJoinedRow,
  participants: ParticipantRef[]
): CoordinationEvent {
  const links: CoordinationEventLinks = {}
  if (row.task_id !== null) links.taskId = row.task_id
  if (row.run_id !== null) links.runId = row.run_id
  if (row.session_id !== null) links.sessionId = row.session_id
  if (row.delivery_request_id !== null) links.deliveryRequestId = row.delivery_request_id
  if (row.artifact_refs !== null) links.artifactRefs = parseJson<string[]>(row.artifact_refs)
  if (row.conversation_thread_id !== null) links.conversationThreadId = row.conversation_thread_id
  if (row.conversation_turn_id !== null) links.conversationTurnId = row.conversation_turn_id

  return {
    eventId: row.event_id,
    projectId: row.project_id,
    seq: row.seq,
    ts: row.ts,
    kind: row.kind,
    actor: parseJson<ParticipantRef>(row.actor),
    semanticSession:
      row.semantic_session === null ? undefined : parseCanonicalSessionRef(row.semantic_session),
    participants: participants.length > 0 ? participants : undefined,
    content: parseJson<CoordinationEventContent>(row.content),
    links: Object.keys(links).length > 0 ? links : undefined,
    source: parseJson<CoordinationEventSource>(row.source),
    meta: parseJson<Record<string, unknown>>(row.meta),
  }
}

export function hydrateHandoff(row: HandoffRow): Handoff {
  return {
    handoffId: row.handoff_id,
    projectId: row.project_id,
    sourceEventId: row.source_event_id,
    taskId: row.task_id ?? undefined,
    from: parseJson<ParticipantRef>(row.from_participant),
    to: parseJson<ParticipantRef>(row.to_participant),
    targetSession:
      row.target_session === null ? undefined : parseCanonicalSessionRef(row.target_session),
    kind: row.kind,
    reason: row.reason ?? undefined,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function hydrateWakeRequest(row: WakeRequestRow): WakeRequest {
  return {
    wakeId: row.wake_id,
    projectId: row.project_id,
    sourceEventId: row.source_event_id,
    sessionRef: parseCanonicalSessionRef(row.session_ref),
    reason: row.reason ?? undefined,
    dedupeKey: row.dedupe_key ?? undefined,
    state: row.state,
    leasedUntil: row.leased_until ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function hydrateLocalDispatchAttempt(row: LocalDispatchAttemptRow): LocalDispatchAttempt {
  return {
    attemptId: row.attempt_id,
    wakeId: row.wake_id ?? undefined,
    target: JSON.parse(row.target) as ParticipantRef,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function getJoinedEventRow(
  sqlite: Database,
  eventId: string
): CoordinationEventJoinedRow | undefined {
  return (
    sqlite
      .query<CoordinationEventJoinedRow, [string]>(`
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
      WHERE e.event_id = ?
    `)
      .get(eventId) ?? undefined
  )
}

export function getEventById(sqlite: Database, eventId: string): CoordinationEvent | undefined {
  const row = getJoinedEventRow(sqlite, eventId)
  if (!row) {
    return undefined
  }

  return hydrateCoordinationEvent(row, listParticipantsForEvent(sqlite, eventId))
}

export function getHandoffById(sqlite: Database, handoffId: string): Handoff | undefined {
  const row = sqlite
    .query<HandoffRow, [string]>('SELECT * FROM handoffs WHERE handoff_id = ?')
    .get(handoffId)

  return row ? hydrateHandoff(row) : undefined
}

export function getHandoffBySourceEventId(sqlite: Database, eventId: string): Handoff | undefined {
  const row = sqlite
    .query<HandoffRow, [string]>('SELECT * FROM handoffs WHERE source_event_id = ?')
    .get(eventId)

  return row ? hydrateHandoff(row) : undefined
}

export function getWakeById(sqlite: Database, wakeId: string): WakeRequest | undefined {
  const row = sqlite
    .query<WakeRequestRow, [string]>('SELECT * FROM wake_requests WHERE wake_id = ?')
    .get(wakeId)

  return row ? hydrateWakeRequest(row) : undefined
}

export function getWakeBySourceEventId(sqlite: Database, eventId: string): WakeRequest | undefined {
  const row = sqlite
    .query<WakeRequestRow, [string]>('SELECT * FROM wake_requests WHERE source_event_id = ?')
    .get(eventId)

  return row ? hydrateWakeRequest(row) : undefined
}

export function listDispatchAttemptsByWakeId(
  sqlite: Database,
  wakeId: string
): LocalDispatchAttempt[] {
  return sqlite
    .query<LocalDispatchAttemptRow, [string]>(
      'SELECT * FROM local_dispatch_attempts WHERE wake_id = ? ORDER BY created_at ASC, attempt_id ASC'
    )
    .all(wakeId)
    .map((row) => hydrateLocalDispatchAttempt(row))
}

export function getEventIdByIdempotencyKey(
  sqlite: Database,
  projectId: string,
  idempotencyKey: string
): string | undefined {
  const row = sqlite
    .query<EventIdRow, [string, string]>(
      'SELECT event_id FROM coordination_events WHERE project_id = ? AND idempotency_key = ?'
    )
    .get(projectId, idempotencyKey)

  return row?.event_id
}
