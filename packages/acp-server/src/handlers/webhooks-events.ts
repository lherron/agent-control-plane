import { parseAcpWebhookEvent } from 'acp-core'

import { badRequest } from '../http.js'
import { parseJsonBody } from '../parsers/body.js'

import type { RouteHandler } from '../routing/route-context.js'

/**
 * POST /v1/webhooks/events — canonical ACP event webhook.
 *
 * Loopback-trusted only for v1. This route is not internet-safe without
 * source authentication/signing; source/id validation here only prevents local
 * producer collisions and malformed envelopes.
 */
export const handleAcpEventWebhook: RouteHandler = async ({ request, deps }) => {
  const jobsStore = deps.jobsStore
  if (jobsStore === undefined) {
    return new Response(null, { status: 204 })
  }

  const parsed = parseAcpWebhookEvent(await parseJsonBody(request))
  if (!parsed.ok) {
    badRequest(parsed.error, { field: 'webhook' })
  }
  const event = parsed.event

  jobsStore.insertInboxEvent({
    eventId: event.event_id,
    eventSeq: event.event_seq,
    source: event.source,
    event: event.event,
    ...(typeof event.occurred_at === 'string' ? { occurredAt: event.occurred_at } : {}),
    payload: event,
  })

  return new Response(null, { status: 204 })
}
