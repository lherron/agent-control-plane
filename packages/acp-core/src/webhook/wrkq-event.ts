/**
 * wrkq webhook payload v2 (schema_version: 2).
 *
 * This is the contract ACP ingests at POST /v1/webhooks/wrkq. The shape is the
 * authority defined by wrkq T-01985 (comment C-03656). Only the fields ACP
 * actually consumes for matching / templating are typed precisely; the rest of
 * the durable payload is preserved verbatim in the inbox for audit/replay.
 */

import { isRecord } from '../internal/guards.js'

export type WrkqWebhookOrigin = {
  /** "human:<slug>" | "agent:<slug>" | "system:<slug>" | "system" */
  actor: string
  run_id?: string | null | undefined
  via?: string | undefined
}

export type WrkqWebhookTransition = {
  from?: string | null | undefined
  to?: string | undefined
}

/** The subset of the v2 payload ACP matches/templates against, plus passthrough. */
export type WrkqWebhookEvent = {
  schema_version: number
  event_id: string
  event_seq: number
  event: string
  occurred_at?: string | undefined
  origin?: WrkqWebhookOrigin | undefined

  ticket_id?: string | undefined
  ticket_uuid?: string | undefined
  project_id?: string | undefined
  project_uuid?: string | undefined
  project_scope_id?: string | undefined

  transition?: WrkqWebhookTransition | null | undefined
  changed?: string[] | undefined

  title?: string | undefined
  slug?: string | undefined
  container_path?: string | undefined
  labels?: string[] | undefined

  state?: string | undefined
  kind?: string | undefined

  /** Anything else from the payload, kept for audit/passthrough. */
  [key: string]: unknown
}

export type ParseWrkqWebhookEventResult =
  | { ok: true; event: WrkqWebhookEvent }
  | { ok: false; error: string }

const SUPPORTED_SCHEMA_VERSION = 2

/**
 * Validate just enough of a wrkq webhook body to durably ingest it: the schema
 * version we understand and the durable identity (event_id, event_seq, event).
 * Everything else is preserved as-is. Fail-closed: an unknown schema version or
 * a missing identity is rejected (never silently coerced).
 */
export function parseWrkqWebhookEvent(body: unknown): ParseWrkqWebhookEventResult {
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

  const eventId = body['event_id']
  if (typeof eventId !== 'string' || eventId.trim().length === 0) {
    return { ok: false, error: 'event_id is required' }
  }

  const eventSeq = body['event_seq']
  if (typeof eventSeq !== 'number' || !Number.isFinite(eventSeq)) {
    return { ok: false, error: 'event_seq must be a finite number' }
  }

  const event = body['event']
  if (typeof event !== 'string' || event.trim().length === 0) {
    return { ok: false, error: 'event is required' }
  }

  return { ok: true, event: body as WrkqWebhookEvent }
}

/**
 * Normalize an origin actor / job agentId for comparison. The webhook origin
 * carries a kind-prefixed slug ("agent:clod") while a job carries a bare agentId
 * ("clod"); strip a leading "agent:" so the two are directly comparable.
 */
export function normalizeAgentActor(value: string): string {
  return value.startsWith('agent:') ? value.slice('agent:'.length) : value
}
