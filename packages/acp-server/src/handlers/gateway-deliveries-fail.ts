import { json } from '../http.js'
import { parseJsonBody, requireRecord, requireTrimmedStringField } from '../parsers/body.js'

import type { RouteHandler } from '../routing/route-context.js'
import {
  requireDeliveryForTransition,
  requireDeliveryRequestId,
  requireFailurableDelivery,
  toApiDeliveryRequest,
} from './interface-shared.js'

export const handleFailGatewayDelivery: RouteHandler = async ({ request, params, deps }) => {
  const deliveryRequestId = requireDeliveryRequestId(params)
  const body = requireRecord(await parseJsonBody(request))
  const delivery = requireDeliveryForTransition(
    deps.interfaceStore.deliveries.get(deliveryRequestId),
    deliveryRequestId
  )
  requireFailurableDelivery(delivery)

  const updatedDelivery = deps.interfaceStore.deliveries.fail({
    deliveryRequestId,
    failureCode: requireTrimmedStringField(body, 'code'),
    failureMessage: requireTrimmedStringField(body, 'message'),
  })

  return json({
    delivery: toApiDeliveryRequest(
      requireDeliveryForTransition(updatedDelivery, deliveryRequestId)
    ),
  })
}
