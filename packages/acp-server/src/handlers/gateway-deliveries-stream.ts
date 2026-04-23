/*
MVP note: this endpoint uses JSON polling instead of SSE. Clients poll with
?since=<createdAt|runId|deliveryRequestId>, and ACP returns queued deliveries
without leasing them so ack/fail remain the only state transitions in this cut.
*/

import { json } from '../http.js'

import type { RouteHandler } from '../routing/route-context.js'
import {
  compareDeliveriesForStream,
  encodeDeliveryCursor,
  isDeliveryAfterCursor,
  parseDeliveryCursor,
  requireGatewayId,
  toApiDeliveryRequest,
} from './interface-shared.js'

export const handleStreamGatewayDeliveries: RouteHandler = async ({ url, params, deps }) => {
  const gatewayId = requireGatewayId(params)
  const rawCursor = url.searchParams.get('since')?.trim() || undefined
  const cursor = parseDeliveryCursor(rawCursor)
  const deliveries = deps.interfaceStore.deliveries
    .listQueuedForGateway(gatewayId)
    .sort(compareDeliveriesForStream)
    .filter((delivery) => (cursor === undefined ? true : isDeliveryAfterCursor(delivery, cursor)))
  const lastDelivery = deliveries.at(-1)
  const nextCursor = lastDelivery !== undefined ? encodeDeliveryCursor(lastDelivery) : rawCursor

  return json({
    deliveries: deliveries.map(toApiDeliveryRequest),
    nextCursor: nextCursor ?? null,
  })
}
