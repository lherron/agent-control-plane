import { parseWrkqWebhookEvent } from 'acp-core'

import { badRequest } from '../http.js'
import { parseJsonBody } from '../parsers/body.js'

import type { RouteHandler } from '../routing/route-context.js'

/**
 * POST /v1/webhooks/wrkq — durable, idempotent ingest of wrkq v2 task events.
 *
 * Loopback-trusted (no auth). The wrkq sender is fire-and-forget, so the handler
 * validates the schema version + durable identity, writes one immutable inbox
 * row keyed by event_id (duplicates are ignored), and returns a fast 204. All
 * matching/minting happens later in the scheduler's event-claim branch.
 */
export const handleWrkqWebhook: RouteHandler = async ({ request, deps }) => {
  const jobsStore = deps.jobsStore
  if (jobsStore === undefined) {
    // No jobs store configured: accept-and-drop so the sender never blocks.
    return new Response(null, { status: 204 })
  }

  const parsed = parseWrkqWebhookEvent(await parseJsonBody(request))
  if (!parsed.ok) {
    badRequest(parsed.error, { field: 'webhook' })
  }
  const event = parsed.event

  jobsStore.insertInboxEvent({
    eventId: event.event_id,
    eventSeq: event.event_seq,
    source: 'wrkq',
    event: event.event,
    ...(typeof event.occurred_at === 'string' ? { occurredAt: event.occurred_at } : {}),
    payload: event as Record<string, unknown>,
  })

  return new Response(null, { status: 204 })
}
