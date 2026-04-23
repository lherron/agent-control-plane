import { normalizeSessionRef } from 'agent-scope'
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

  const updatedDelivery = requireDeliveryForTransition(
    deps.interfaceStore.deliveries.ack(deliveryRequestId, new Date().toISOString()),
    deliveryRequestId
  )

  deps.interfaceStore.lastDeliveryContext.recordAckedDelivery(
    normalizeSessionRef({
      scopeRef: updatedDelivery.scopeRef,
      laneRef: updatedDelivery.laneRef,
    }),
    {
      gatewayId: updatedDelivery.gatewayId,
      conversationRef: updatedDelivery.conversationRef,
      ...(updatedDelivery.threadRef !== undefined ? { threadRef: updatedDelivery.threadRef } : {}),
      deliveryRequestId: updatedDelivery.deliveryRequestId,
      ackedAt: updatedDelivery.deliveredAt ?? new Date().toISOString(),
    }
  )

  if (deps.conversationStore !== undefined) {
    const turn = deps.conversationStore.findTurnByLink('linksDeliveryRequestId', deliveryRequestId)
    if (turn !== undefined) {
      deps.conversationStore.updateRenderState(turn.turnId, 'delivered')
    }
  }

  return json({
    delivery: toApiDeliveryRequest(updatedDelivery),
  })
}
