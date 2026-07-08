/**
 * Canonical ACP webhook event envelope.
 *
 * Producer event_seq is source-local provenance. ACP stores and drains by that
 * value as an implementation detail, but no cross-source ordering invariant may
 * depend on it unless ACP assigns the sequence itself in a later version.
 */

import { isRecord } from '../internal/guards.js'

import type { WrkqWebhookEvent, WrkqWebhookOrigin } from './wrkq-event.js'

export type AcpWebhookOrigin = {
  actor?: string | undefined
  kind?: 'human' | 'agent' | 'system' | undefined
  run_id?: string | null | undefined
  causation_ref?: string | undefined
  via?: string | undefined
  [key: string]: unknown
}

export type AcpWebhookSubject = {
  type: string
  id?: string | undefined
  [key: string]: unknown
}

export type AcpWebhookEvent = {
  schema_version: 1
  source: string
  event_id: string
  canonical_event_id: string
  event_seq: number
  event: string
  occurred_at?: string | undefined
  origin?: AcpWebhookOrigin | undefined
  subject?: AcpWebhookSubject | undefined
  payload: Readonly<Record<string, unknown>>
}

export type ParseAcpWebhookEventResult =
  | { ok: true; event: AcpWebhookEvent }
  | { ok: false; error: string }

const SUPPORTED_SCHEMA_VERSION = 1
const SOURCE_PATTERN = /^[a-z][a-z0-9._-]{0,79}$/

function actorKind(actor: string): 'human' | 'agent' | 'system' | undefined {
  const idx = actor.indexOf(':')
  const kind = idx === -1 ? actor : actor.slice(0, idx)
  return kind === 'human' || kind === 'agent' || kind === 'system' ? kind : undefined
}

function parseOrigin(value: unknown): AcpWebhookOrigin | undefined | string {
  if (value === undefined) {
    return undefined
  }
  if (!isRecord(value)) {
    return 'origin must be an object'
  }
  const actor = value['actor']
  const kind = value['kind']
  const causationRef = value['causation_ref']
  if (actor !== undefined && typeof actor !== 'string') {
    return 'origin.actor must be a string when present'
  }
  if (kind !== undefined && kind !== 'human' && kind !== 'agent' && kind !== 'system') {
    return "origin.kind must be 'human', 'agent', or 'system' when present"
  }
  if (causationRef !== undefined && typeof causationRef !== 'string') {
    return 'origin.causation_ref must be a string when present'
  }
  return {
    ...value,
    ...(typeof actor === 'string' ? { actor } : {}),
    ...(typeof causationRef === 'string' ? { causation_ref: causationRef } : {}),
    ...(kind === 'human' || kind === 'agent' || kind === 'system'
      ? { kind }
      : typeof actor === 'string' && actorKind(actor) !== undefined
        ? { kind: actorKind(actor) }
        : {}),
  } as AcpWebhookOrigin
}

function parseSubject(value: unknown): AcpWebhookSubject | undefined | string {
  if (value === undefined) {
    return undefined
  }
  if (!isRecord(value)) {
    return 'subject must be an object'
  }
  const type = value['type']
  if (typeof type !== 'string' || type.trim().length === 0) {
    return 'subject.type is required when subject is present'
  }
  const id = value['id']
  if (id !== undefined && typeof id !== 'string') {
    return 'subject.id must be a string when present'
  }
  return {
    ...value,
    type,
    ...(typeof id === 'string' ? { id } : {}),
  } as AcpWebhookSubject
}

export function canonicalAcpEventId(source: string, eventId: string): string {
  return `${source}:${eventId}`
}

export function parseAcpWebhookEvent(body: unknown): ParseAcpWebhookEventResult {
  if (!isRecord(body)) {
    return { ok: false, error: 'webhook body must be a JSON object' }
  }

  const schemaVersion = body['schema_version']
  if (schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    return {
      ok: false,
      error: `unsupported schema_version: ${String(schemaVersion)} (expected ${SUPPORTED_SCHEMA_VERSION})`,
    }
  }

  const source = body['source']
  if (typeof source !== 'string' || !SOURCE_PATTERN.test(source)) {
    return {
      ok: false,
      error: 'source must match /^[a-z][a-z0-9._-]{0,79}$/',
    }
  }

  const eventId = body['event_id']
  if (typeof eventId !== 'string' || eventId.trim().length === 0) {
    return { ok: false, error: 'event_id is required' }
  }

  const eventSeq = body['event_seq']
  if (typeof eventSeq !== 'number' || !Number.isInteger(eventSeq) || eventSeq < 0) {
    return { ok: false, error: 'event_seq must be a non-negative integer' }
  }

  const event = body['event']
  if (typeof event !== 'string' || event.trim().length === 0) {
    return { ok: false, error: 'event is required' }
  }

  const occurredAt = body['occurred_at']
  if (occurredAt !== undefined && typeof occurredAt !== 'string') {
    return { ok: false, error: 'occurred_at must be a string when present' }
  }

  const origin = parseOrigin(body['origin'])
  if (typeof origin === 'string') {
    return { ok: false, error: origin }
  }

  const subject = parseSubject(body['subject'])
  if (typeof subject === 'string') {
    return { ok: false, error: subject }
  }

  const payload = body['payload']
  if (payload !== undefined && !isRecord(payload)) {
    return { ok: false, error: 'payload must be an object when present' }
  }

  const canonicalEventId = canonicalAcpEventId(source, eventId)
  const canonicalFromBody = body['canonical_event_id']
  if (canonicalFromBody !== undefined && canonicalFromBody !== canonicalEventId) {
    return { ok: false, error: 'canonical_event_id does not match source:event_id' }
  }

  return {
    ok: true,
    event: {
      schema_version: SUPPORTED_SCHEMA_VERSION,
      source,
      event_id: eventId,
      canonical_event_id: canonicalEventId,
      event_seq: eventSeq,
      event,
      ...(typeof occurredAt === 'string' ? { occurred_at: occurredAt } : {}),
      ...(origin !== undefined ? { origin } : {}),
      ...(subject !== undefined ? { subject } : {}),
      payload: (payload ?? {}) as Record<string, unknown>,
    },
  }
}

export function adaptWrkqWebhookEvent(event: WrkqWebhookEvent): AcpWebhookEvent {
  const origin = adaptWrkqOrigin(event.origin)
  const subject =
    typeof event.ticket_id === 'string' || typeof event.kind === 'string'
      ? {
          type: typeof event.kind === 'string' && event.kind.length > 0 ? event.kind : 'task',
          ...(typeof event.ticket_id === 'string' ? { id: event.ticket_id } : {}),
        }
      : undefined
  return {
    schema_version: SUPPORTED_SCHEMA_VERSION,
    source: 'wrkq',
    event_id: event.event_id,
    canonical_event_id: canonicalAcpEventId('wrkq', event.event_id),
    event_seq: event.event_seq,
    event: event.event,
    ...(typeof event.occurred_at === 'string' ? { occurred_at: event.occurred_at } : {}),
    ...(origin !== undefined ? { origin } : {}),
    ...(subject !== undefined ? { subject } : {}),
    payload: event,
  }
}

function adaptWrkqOrigin(origin: WrkqWebhookOrigin | undefined): AcpWebhookOrigin | undefined {
  if (origin === undefined) {
    return undefined
  }
  return {
    ...origin,
    kind: actorKind(origin.actor),
  }
}

export function isAgentOriginEvent(event: AcpWebhookEvent): boolean {
  const actor = event.origin?.actor
  if (typeof actor === 'string' && actor.startsWith('agent:')) {
    return true
  }
  return event.origin?.kind === 'agent'
}
