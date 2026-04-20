import type { CoordinationStore } from '../storage/open-store.js'
import {
  getEventById,
  getEventIdByIdempotencyKey,
  getHandoffBySourceEventId,
  getWakeBySourceEventId,
  listDispatchAttemptsByWakeId,
} from '../storage/records.js'
import type { CoordinationEvent, CoordinationEventInput } from '../types/coordination-event.js'
import type { Handoff, HandoffInput } from '../types/handoff.js'
import type { LocalDispatchAttempt } from '../types/local-dispatch-attempt.js'
import type { ParticipantRef } from '../types/participant-ref.js'
import type { WakeRequest, WakeRequestInput } from '../types/wake-request.js'
import { stableStringify } from '../util/json.js'
import { nextProjectSequence } from '../util/sequence.js'
import { canonicalizeSessionRef, formatCanonicalSessionRef } from '../util/session-ref.js'
import { newUlid } from '../util/ulid.js'

export type AppendEventCommand = {
  projectId: string
  idempotencyKey?: string | undefined
  event: CoordinationEventInput
  handoff?: HandoffInput | undefined
  wake?: WakeRequestInput | undefined
  localRecipients?: ParticipantRef[] | undefined
}

export type AppendEventResult = {
  event: CoordinationEvent
  handoff?: Handoff | undefined
  wake?: WakeRequest | undefined
  localDispatchAttempts: LocalDispatchAttempt[]
}

function normalizeEventProjectId(projectId: string, eventProjectId?: string): void {
  if (eventProjectId !== undefined && eventProjectId !== projectId) {
    throw new Error(`appendEvent projectId mismatch: ${eventProjectId} !== ${projectId}`)
  }
}

function buildExistingResult(store: CoordinationStore, eventId: string): AppendEventResult {
  const event = getEventById(store.sqlite, eventId)
  if (!event) {
    throw new Error(`Coordination event ${eventId} not found`)
  }

  const handoff = getHandoffBySourceEventId(store.sqlite, eventId)
  const wake = getWakeBySourceEventId(store.sqlite, eventId)

  return {
    event,
    handoff,
    wake,
    localDispatchAttempts: wake ? listDispatchAttemptsByWakeId(store.sqlite, wake.wakeId) : [],
  }
}

function assertInitialHandoffState(state?: Handoff['state']): Handoff['state'] {
  if (state !== undefined && state !== 'open') {
    throw new Error(`appendEvent handoff state must start as "open", received "${state}"`)
  }

  return 'open'
}

function assertInitialWakeState(state?: WakeRequest['state']): WakeRequest['state'] {
  if (state !== undefined && state !== 'queued') {
    throw new Error(`appendEvent wake state must start as "queued", received "${state}"`)
  }

  return 'queued'
}

export function appendEvent(
  store: CoordinationStore,
  command: AppendEventCommand
): AppendEventResult {
  normalizeEventProjectId(command.projectId, command.event.projectId)

  if (command.idempotencyKey) {
    const existingEventId = getEventIdByIdempotencyKey(
      store.sqlite,
      command.projectId,
      command.idempotencyKey
    )

    if (existingEventId) {
      return buildExistingResult(store, existingEventId)
    }
  }

  return store.sqlite.transaction((cmd: AppendEventCommand) => {
    const now = cmd.event.ts ?? new Date().toISOString()
    const seq = nextProjectSequence(store.sqlite, cmd.projectId)
    const eventId = cmd.event.eventId ?? newUlid()
    const semanticSession =
      cmd.event.semanticSession === undefined
        ? null
        : formatCanonicalSessionRef(canonicalizeSessionRef(cmd.event.semanticSession))

    store.sqlite
      .query(
        `
          INSERT INTO coordination_events (
            event_id,
            project_id,
            seq,
            ts,
            kind,
            actor,
            semantic_session,
            content,
            source,
            meta,
            idempotency_key
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        eventId,
        cmd.projectId,
        seq,
        now,
        cmd.event.kind,
        cmd.event.actor ? stableStringify(cmd.event.actor) : null,
        semanticSession,
        cmd.event.content ? JSON.stringify(cmd.event.content) : null,
        cmd.event.source ? JSON.stringify(cmd.event.source) : null,
        cmd.event.meta ? JSON.stringify(cmd.event.meta) : null,
        cmd.idempotencyKey ?? null
      )

    store.sqlite
      .query(
        `
          INSERT INTO coordination_event_links (
            event_id,
            project_id,
            task_id,
            run_id,
            session_id,
            delivery_request_id,
            artifact_refs,
            conversation_thread_id,
            conversation_turn_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        eventId,
        cmd.projectId,
        cmd.event.links?.taskId ?? null,
        cmd.event.links?.runId ?? null,
        cmd.event.links?.sessionId ?? null,
        cmd.event.links?.deliveryRequestId ?? null,
        cmd.event.links?.artifactRefs ? JSON.stringify(cmd.event.links.artifactRefs) : null,
        cmd.event.links?.conversationThreadId ?? null,
        cmd.event.links?.conversationTurnId ?? null
      )

    for (const participant of cmd.event.participants ?? []) {
      store.sqlite
        .query('INSERT INTO coordination_event_participants (event_id, participant) VALUES (?, ?)')
        .run(eventId, stableStringify(participant))
    }

    let handoff: Handoff | undefined
    if (cmd.handoff) {
      const handoffState = assertInitialHandoffState(cmd.handoff.state)
      const handoffId = newUlid()
      const targetSession =
        cmd.handoff.targetSession === undefined
          ? undefined
          : canonicalizeSessionRef(cmd.handoff.targetSession)

      store.sqlite
        .query(
          `
            INSERT INTO handoffs (
              handoff_id,
              project_id,
              source_event_id,
              task_id,
              from_participant,
              to_participant,
              target_session,
              kind,
              reason,
              state,
              created_at,
              updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
        )
        .run(
          handoffId,
          cmd.projectId,
          eventId,
          cmd.handoff.taskId ?? cmd.event.links?.taskId ?? null,
          cmd.handoff.from ? stableStringify(cmd.handoff.from) : null,
          cmd.handoff.to ? stableStringify(cmd.handoff.to) : null,
          targetSession ? formatCanonicalSessionRef(targetSession) : null,
          cmd.handoff.kind,
          cmd.handoff.reason ?? null,
          handoffState,
          now,
          now
        )

      handoff = {
        handoffId,
        projectId: cmd.projectId,
        sourceEventId: eventId,
        taskId: cmd.handoff.taskId ?? cmd.event.links?.taskId,
        from: cmd.handoff.from,
        to: cmd.handoff.to,
        targetSession,
        kind: cmd.handoff.kind,
        reason: cmd.handoff.reason,
        state: handoffState,
        createdAt: now,
        updatedAt: now,
      }
    }

    let wake: WakeRequest | undefined
    if (cmd.wake) {
      const wakeState = assertInitialWakeState(cmd.wake.state)
      const wakeId = newUlid()
      const sessionRef = canonicalizeSessionRef(cmd.wake.sessionRef)

      store.sqlite
        .query(
          `
            INSERT INTO wake_requests (
              wake_id,
              project_id,
              source_event_id,
              session_ref,
              reason,
              dedupe_key,
              state,
              leased_until,
              created_at,
              updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
        )
        .run(
          wakeId,
          cmd.projectId,
          eventId,
          formatCanonicalSessionRef(sessionRef),
          cmd.wake.reason ?? null,
          cmd.wake.dedupeKey ?? null,
          wakeState,
          cmd.wake.leasedUntil ?? null,
          now,
          now
        )

      wake = {
        wakeId,
        projectId: cmd.projectId,
        sourceEventId: eventId,
        sessionRef,
        reason: cmd.wake.reason,
        dedupeKey: cmd.wake.dedupeKey,
        state: wakeState,
        leasedUntil: cmd.wake.leasedUntil,
        createdAt: now,
        updatedAt: now,
      }
    }

    const localDispatchAttempts: LocalDispatchAttempt[] = []
    for (const target of cmd.localRecipients ?? []) {
      const attemptId = newUlid()
      store.sqlite
        .query(
          `
            INSERT INTO local_dispatch_attempts (
              attempt_id,
              wake_id,
              target,
              state,
              created_at,
              updated_at
            ) VALUES (?, ?, ?, ?, ?, ?)
          `
        )
        .run(attemptId, wake?.wakeId ?? null, stableStringify(target), 'queued', now, now)

      localDispatchAttempts.push({
        attemptId,
        wakeId: wake?.wakeId,
        target,
        state: 'queued',
        createdAt: now,
        updatedAt: now,
      })
    }

    return {
      event: {
        eventId,
        projectId: cmd.projectId,
        seq,
        ts: now,
        kind: cmd.event.kind,
        actor: cmd.event.actor,
        semanticSession:
          cmd.event.semanticSession === undefined
            ? undefined
            : canonicalizeSessionRef(cmd.event.semanticSession),
        participants: cmd.event.participants,
        content: cmd.event.content,
        links: cmd.event.links,
        source: cmd.event.source,
        meta: cmd.event.meta,
      },
      handoff,
      wake,
      localDispatchAttempts,
    }
  })(command)
}
