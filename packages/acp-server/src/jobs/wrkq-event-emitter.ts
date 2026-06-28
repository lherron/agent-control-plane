import type { AdminStore } from 'acp-admin-store'
import type { AcpWebhookEvent } from 'acp-core'

/**
 * ACP-layer wrkq/wrkf lifecycle telemetry emitter (T-05270).
 *
 * INVARIANT (per daedalus ruling msg #10844): wrkq/wrkf own authoritative task
 * and workflow state, and the wrkq webhook ingest commits BEFORE ACP observes
 * it. `systemEvents` is an IMMUTABLE OBSERVER PROJECTION — emission never mutates
 * wrkq state, jobs-inbox state, or the webhook response contract. A failed,
 * duplicate, or slow append is dropped (optionally logged via `onError`); it can
 * never roll anything back. Exactly-once is enforced against the systemEvents
 * store itself (`existsWithPayloadField` on the canonical source-qualified id),
 * so webhook replays and double-delivery cannot double-append.
 *
 * Only the explicit allowlist below produces a system-event / Discord card.
 * Unknown wrkq event names stay ingested for the jobs inbox but emit nothing
 * here, until the table and a renderer are extended.
 */

/**
 * wrkq/wrkf webhook event name -> system-event kind. The kind family follows the
 * DOMAIN (wrkq task vs wrkf workflow), not the transport source (all arrive under
 * source:"wrkq"). This is a closed allowlist by design (daedalus condition 3).
 */
const KIND_BY_EVENT: Readonly<Record<string, string>> = {
  created: 'wrkq.created',
  updated: 'wrkq.updated',
  moved: 'wrkq.moved',
  archived: 'wrkq.archived',
  purged: 'wrkq.purged',
  comment_added: 'wrkq.comment_added',
  workflow_attached: 'wrkf.workflow_attached',
  workflow_transitioned: 'wrkf.workflow_transitioned',
}

/** System-event payload field carrying the canonical source-qualified identity
 * (`source:event_id`). The idempotency guard keys on this, never a naked id. */
export const CANONICAL_EVENT_ID_FIELD = 'canonicalEventId'

/** Fields from the wrkq v2 payload carried verbatim into the system event so the
 * Discord card builder can render without touching wrkq authority stores. */
const CARRIED_FIELDS: readonly string[] = [
  'ticket_id',
  'ticket_uuid',
  'slug',
  'title',
  'state',
  'kind',
  'container_path',
  'labels',
  'transition',
  'changed',
  'changes',
  'origin',
  'workflow',
  'subject',
  'project_id',
  'project_scope_id',
]

export type WrkqEventEmitter = {
  /**
   * Project a recognized wrkq/wrkf webhook event into systemEvents. Observer
   * only: never throws into the caller, and is a no-op for unrecognized event
   * names. Idempotent across webhook replays.
   */
  emit(event: AcpWebhookEvent): void
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function mapEventKind(event: string): string | undefined {
  return KIND_BY_EVENT[event]
}

export function createWrkqEventEmitter(input: {
  systemEvents: AdminStore['systemEvents']
  now?: (() => Date) | undefined
  /** Best-effort observability hook for dropped appends. Never re-thrown. */
  onError?: ((err: unknown, event: AcpWebhookEvent) => void) | undefined
}): WrkqEventEmitter {
  const now = input.now ?? (() => new Date())

  function buildPayload(event: AcpWebhookEvent, canonicalEventId: string): Record<string, unknown> {
    const src = event.payload as Record<string, unknown>
    const projectId =
      asNonEmptyString(src['project_scope_id']) ?? asNonEmptyString(src['project_id']) ?? 'wrkq'
    const payload: Record<string, unknown> = {
      [CANONICAL_EVENT_ID_FIELD]: canonicalEventId,
      sourceEventId: event.event_id,
      source: event.source,
      event: event.event,
      projectId,
    }
    if (event.origin !== undefined) {
      payload['origin'] = event.origin
    }
    for (const key of CARRIED_FIELDS) {
      if (src[key] !== undefined) {
        payload[key] = src[key]
      }
    }
    return payload
  }

  function emit(event: AcpWebhookEvent): void {
    try {
      const kind = mapEventKind(event.event)
      if (kind === undefined) {
        return
      }
      const canonicalEventId = event.canonical_event_id
      if (
        input.systemEvents.existsWithPayloadField({
          kind,
          field: CANONICAL_EVENT_ID_FIELD,
          value: canonicalEventId,
        })
      ) {
        return
      }
      const payload = buildPayload(event, canonicalEventId)
      input.systemEvents.append({
        projectId: payload['projectId'] as string,
        kind,
        payload,
        occurredAt: asNonEmptyString(event.occurred_at) ?? now().toISOString(),
        recordedAt: now().toISOString(),
      })
    } catch (err) {
      input.onError?.(err, event)
    }
  }

  return { emit }
}
