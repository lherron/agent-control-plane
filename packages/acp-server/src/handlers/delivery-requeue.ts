import { AcpHttpError, json, notFound } from '../http.js'
import { parseJsonBody, requireRecord, requireTrimmedStringField } from '../parsers/body.js'

import type { RouteHandler } from '../routing/route-context.js'
import { requireDeliveryRequestId, toApiDeliveryRequest } from './interface-shared.js'

export const handleRequeueDelivery: RouteHandler = async ({ request, params, deps }) => {
  const deliveryRequestId = requireDeliveryRequestId(params)
  const body = requireRecord(await parseJsonBody(request))
  const requeuedBy = requireTrimmedStringField(body, 'requeuedBy')
  const result = deps.interfaceStore.deliveries.requeue(deliveryRequestId, { requeuedBy })

  if (!result.ok) {
    if (result.code === 'not_found') {
      notFound(`delivery request not found: ${deliveryRequestId}`, { deliveryRequestId })
    }

    throw new AcpHttpError(
      409,
      'delivery_not_requeueable',
      `delivery request ${deliveryRequestId} cannot be requeued`,
      { deliveryRequestId }
    )
  }

  return json(
    {
      delivery: toApiDeliveryRequest(result.delivery),
    },
    201
  )
}
