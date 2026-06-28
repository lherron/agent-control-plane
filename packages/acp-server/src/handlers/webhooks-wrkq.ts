import { adaptWrkqWebhookEvent, parseWrkqWebhookEvent } from 'acp-core'

import { badRequest } from '../http.js'
import { createWrkqEventEmitter } from '../jobs/wrkq-event-emitter.js'
import { parseJsonBody } from '../parsers/body.js'

import type { RouteHandler } from '../routing/route-context.js'

/**
 * POST /v1/webhooks/wrkq — durable, idempotent ingest of wrkq v2 task events.
 *
 * Loopback-trusted (no auth). The wrkq sender is fire-and-forget, so the handler
 * validates the schema version + durable identity, adapts the payload into the
 * canonical ACP event model, and returns a fast 204.
 *
 * Two independent observers run off that one already-committed wrkq transition
 * (daedalus ruling msg #10844):
 *   1. systemEvents lifecycle projection — drives the #work-activity Discord
 *      cards (T-05270). adminStore is a mandatory ACP dep, so this runs whether
 *      or not a jobs store is configured. Observer only: a failed/duplicate
 *      append never affects the response or wrkq/jobs state.
 *   2. jobs inbox row — keyed by source:event_id, drives the scheduler's
 *      event-claim branch. Only when a jobs store is configured.
 *
 * A malformed body fails closed with 400 before either observer runs.
 */
export const handleWrkqWebhook: RouteHandler = async ({ request, deps }) => {
  const parsed = parseWrkqWebhookEvent(await parseJsonBody(request))
  if (!parsed.ok) {
    badRequest(parsed.error, { field: 'webhook' })
  }
  const event = adaptWrkqWebhookEvent(parsed.event)

  // Observer projection: append a lifecycle system event for recognized events,
  // before (and independent of) the optional jobs-inbox write.
  createWrkqEventEmitter({
    systemEvents: deps.adminStore.systemEvents,
    onError: (err) => {
      process.stderr.write(
        `${new Date().toISOString()} [acp-server] WARN wrkq.systemevent.emit_failed ${JSON.stringify(
          {
            canonicalEventId: event.canonical_event_id,
            event: event.event,
            err: err instanceof Error ? err.message : String(err),
          }
        )}\n`
      )
    },
  }).emit(event)

  // Jobs inbox ingest is optional: only when a jobs store is configured.
  deps.jobsStore?.insertInboxEvent({
    eventId: event.event_id,
    eventSeq: event.event_seq,
    source: event.source,
    event: event.event,
    ...(typeof event.occurred_at === 'string' ? { occurredAt: event.occurred_at } : {}),
    payload: event,
  })

  return new Response(null, { status: 204 })
}
