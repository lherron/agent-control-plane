import { json } from '../http.js'

import type { RouteHandler } from '../routing/route-context.js'
import {
  requireAckableDelivery,
  requireDeliveryForTransition,
  requireDeliveryRequestId,
  toApiDeliveryRequest,
} from './interface-shared.js'

export const handleAckGatewayDelivery: RouteHandler = async ({ params, deps }) => {
  const deliveryRequestId = requireDeliveryRequestId(params)
  const delivery = requireDeliveryForTransition(
    deps.interfaceStore.deliveries.get(deliveryRequestId),
    deliveryRequestId
  )
  requireAckableDelivery(delivery)

  const updatedDelivery = deps.interfaceStore.deliveries.ack(
    deliveryRequestId,
    new Date().toISOString()
  )

  return json({
    delivery: toApiDeliveryRequest(
      requireDeliveryForTransition(updatedDelivery, deliveryRequestId)
    ),
  })
}
