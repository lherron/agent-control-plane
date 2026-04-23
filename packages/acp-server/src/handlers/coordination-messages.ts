import { type Actor, type MessageParticipant, messageParticipantKinds } from 'acp-core'
import type { SessionRef } from 'agent-scope'
import type { ParticipantRef } from 'coordination-substrate'

import { appendRawCoordinationMessage } from '../coordination/raw-append.js'
import { badRequest, json } from '../http.js'
import { resolveLaunchIntent } from '../launch-role-scoped.js'
import {
  isRecord,
  parseJsonBody,
  readOptionalBooleanField,
  readOptionalRecordField,
  requireRecord,
  requireTrimmedStringField,
} from '../parsers/body.js'

import type { RouteHandler } from '../routing/route-context.js'

// ---------------------------------------------------------------------------
// Participant parsing
// ---------------------------------------------------------------------------

const VALID_KINDS = messageParticipantKinds as readonly string[]

function parseParticipant(
  raw: unknown,
  prefix: 'from' | 'to'
): MessageParticipant {
  if (!isRecord(raw)) {
    badRequest(`${prefix} must be an object`)
  }

  const kind = raw['kind']
  if (typeof kind !== 'string' || !VALID_KINDS.includes(kind)) {
    badRequest(`${prefix}.kind must be one of: ${VALID_KINDS.join(', ')}`)
  }

  switch (kind) {
    case 'human':
      return {
        kind: 'human',
        ...(typeof raw['humanId'] === 'string' ? { humanId: raw['humanId'] } : {}),
        ...(typeof raw['displayName'] === 'string' ? { displayName: raw['displayName'] } : {}),
      }

    case 'agent':
      if (typeof raw['agentId'] !== 'string' || raw['agentId'].length === 0) {
        badRequest(`${prefix}.agentId must be a non-empty string`)
      }
      return { kind: 'agent', agentId: raw['agentId'] as string }

    case 'sessionRef': {
      const sessionRefRaw = raw['sessionRef']
      if (!isRecord(sessionRefRaw)) {
        badRequest(`${prefix}.sessionRef must be an object`)
      }
      const scopeRef = sessionRefRaw['scopeRef']
      if (typeof scopeRef !== 'string' || scopeRef.length === 0) {
        badRequest(`${prefix}.sessionRef.scopeRef must be a non-empty string`)
      }
      const laneRef =
        typeof sessionRefRaw['laneRef'] === 'string' ? sessionRefRaw['laneRef'] : undefined
      return {
        kind: 'sessionRef',
        sessionRef: { scopeRef, ...(laneRef !== undefined ? { laneRef } : {}) } as SessionRef,
      }
    }

    case 'system':
      return { kind: 'system' }

    default:
      badRequest(`${prefix}.kind must be one of: ${VALID_KINDS.join(', ')}`)
  }
}

// ---------------------------------------------------------------------------
// Map high-level participant → coordination-substrate ParticipantRef
// ---------------------------------------------------------------------------

function toSubstrateActor(p: MessageParticipant): ParticipantRef | undefined {
  switch (p.kind) {
    case 'agent':
      return { kind: 'agent', agentId: p.agentId }
    case 'human':
      return { kind: 'human', ref: p.humanId ?? p.displayName ?? 'anonymous' }
    case 'sessionRef':
      return { kind: 'session', sessionRef: p.sessionRef }
    case 'system':
      return undefined
  }
}

function toSubstrateParticipant(p: MessageParticipant): ParticipantRef | undefined {
  return toSubstrateActor(p)
}

function toSubstrateActorFromResolvedActor(actor: Actor): ParticipantRef {
  switch (actor.kind) {
    case 'agent':
      return { kind: 'agent', agentId: actor.id }
    case 'human':
      return { kind: 'human', id: actor.id }
    case 'system':
      return { kind: 'system', id: actor.id }
  }
}

// ---------------------------------------------------------------------------
// Body normalisation
// ---------------------------------------------------------------------------

function normalizeBody(raw: unknown): { kind: 'text' | 'json'; body: string } {
  if (typeof raw === 'string') {
    return { kind: 'text', body: raw }
  }

  if (isRecord(raw)) {
    const bodyKind = typeof raw['kind'] === 'string' ? raw['kind'] : 'json'
    const inner = raw['body']
    return {
      kind: bodyKind === 'text' ? 'text' : 'json',
      body: typeof inner === 'string' ? inner : JSON.stringify(inner),
    }
  }

  badRequest('body must be a string or an object')
}

// ---------------------------------------------------------------------------
// Extract sessionRef from the "to" participant (for dispatch/wake)
// ---------------------------------------------------------------------------

function sessionRefFromTo(to: MessageParticipant): SessionRef | undefined {
  if (to.kind === 'sessionRef') {
    return to.sessionRef
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Flatten body text for dispatch (the "content" / "initialPrompt" value)
// ---------------------------------------------------------------------------

function bodyAsString(raw: unknown): string {
  if (typeof raw === 'string') {
    return raw
  }
  if (isRecord(raw)) {
    const inner = raw['body']
    return typeof inner === 'string' ? inner : JSON.stringify(inner)
  }
  return String(raw)
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const handleCreateCoordinationMessage: RouteHandler = async (context) => {
  const { request, deps } = context
  const body = requireRecord(await parseJsonBody(request))
  const projectId = requireTrimmedStringField(body, 'projectId')
  const from = parseParticipant(body['from'], 'from')
  const to = parseParticipant(body['to'], 'to')
  const rawBody = body['body']
  if (rawBody === undefined) {
    badRequest('body is required')
  }
  const content = normalizeBody(rawBody)

  const options = readOptionalRecordField(body, 'options')
  const wakeFlag = options !== undefined ? readOptionalBooleanField(options, 'wake') : undefined
  const dispatchFlag =
    options !== undefined ? readOptionalBooleanField(options, 'dispatch') : undefined
  const coordinationOnlyFlag =
    options !== undefined ? readOptionalBooleanField(options, 'coordinationOnly') : undefined

  // --- 1. Write coordination event via raw-append helper ---

  const resolvedActor = context.actor ?? deps.defaultActor
  const actor = toSubstrateActorFromResolvedActor(resolvedActor)
  const participant = toSubstrateParticipant(to)
  const participants = participant !== undefined ? [participant] : []

  const wakeSessionRef =
    wakeFlag === true && coordinationOnlyFlag !== true ? sessionRefFromTo(to) : undefined
  if (wakeFlag === true && coordinationOnlyFlag !== true && wakeSessionRef === undefined) {
    badRequest('wake requires a sessionRef recipient (to.kind must be "sessionRef")')
  }

  const appendResult = appendRawCoordinationMessage(deps.coordStore, {
    projectId,
    event: {
      ts: new Date().toISOString(),
      kind: 'message.posted',
      actor,
      participants,
      content,
    },
    ...(wakeSessionRef !== undefined
      ? {
          wake: {
            sessionRef: wakeSessionRef,
            reason: 'coordination-message wake',
          },
        }
      : {}),
  })

  const result: Record<string, unknown> = {
    coordinationEventId: appendResult.event.eventId,
    messageId: appendResult.event.eventId,
  }

  if (appendResult.wake !== undefined) {
    result['wakeRequestId'] = appendResult.wake.wakeId
  }

  // --- 2. Optionally dispatch through the shared inputs path ---

  if (dispatchFlag === true && coordinationOnlyFlag !== true) {
    const toSessionRef = sessionRefFromTo(to)
    if (toSessionRef === undefined) {
      badRequest('dispatch requires a sessionRef recipient (to.kind must be "sessionRef")')
    }

    const contentText = bodyAsString(rawBody)

    const attemptResult = deps.inputAttemptStore.createAttempt({
      sessionRef: toSessionRef,
      content: contentText,
      actor: resolvedActor,
      runStore: deps.runStore,
    })

    if (attemptResult.created && deps.launchRoleScopedRun !== undefined) {
      const intent = await resolveLaunchIntent(deps, toSessionRef, {
        initialPrompt: contentText,
      })
      await deps.launchRoleScopedRun({
        sessionRef: toSessionRef,
        intent,
        acpRunId: attemptResult.runId,
        inputAttemptId: attemptResult.inputAttempt.inputAttemptId,
        runStore: deps.runStore,
      })
    }

    result['inputAttemptId'] = attemptResult.inputAttempt.inputAttemptId
    result['runId'] = attemptResult.runId
  }

  return json(result, 201)
}
