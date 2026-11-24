import { json } from '../http.js'
import type { RouteHandler } from '../routing/route-context.js'
import {
  requireDeliveryForTransition,
  requireDeliveryRequestId,
  toApiDeliveryRequest,
} from './interface-shared.js'

/**
 * Read one delivery request by id. A pulpit post answers 201 when the delivery
 * is queued, not when the gateway has delivered it. A caller that must know
 * the message actually went out (Foundry's incident handler, R-00760) polls
 * this until `status` is `delivered` or `failed`, and falls back to email.
 */
export const handleGetGatewayDelivery: RouteHandler = async ({ params, deps }) => {
  const deliveryRequestId = requireDeliveryRequestId(params)
  const delivery = requireDeliveryForTransition(
    deps.interfaceStore.deliveries.get(deliveryRequestId),
    deliveryRequestId
  )
  return json({ delivery: toApiDeliveryRequest(delivery) })
}
