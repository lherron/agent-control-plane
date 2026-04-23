import { badRequest, json } from '../http.js'

import type { RouteHandler } from '../routing/route-context.js'

function parseLimit(rawLimit: string | null): number {
  if (rawLimit === null || rawLimit.trim().length === 0) {
    return 50
  }

  const limit = Number(rawLimit)
  if (!Number.isInteger(limit) || limit <= 0) {
    badRequest('limit must be a positive integer', { field: 'limit' })
  }

  return limit
}

export const handleListFailedDeliveries: RouteHandler = async ({ url, deps }) => {
  const status = url.searchParams.get('status')?.trim()
  if (status !== 'failed') {
    badRequest('status must be "failed"', { field: 'status' })
  }

  const gatewayId = url.searchParams.get('gatewayId')?.trim() || undefined
  const since = url.searchParams.get('since')?.trim() || undefined
  const limit = parseLimit(url.searchParams.get('limit'))
  const deliveries = deps.interfaceStore.deliveries.listFailed({
    ...(gatewayId !== undefined ? { gatewayId } : {}),
    ...(since !== undefined ? { since } : {}),
    limit,
  })
  const nextCursor =
    deliveries.length === limit ? (deliveries[deliveries.length - 1]?.createdAt ?? null) : null

  return json({
    deliveries: deliveries.map((delivery) => ({
      deliveryRequestId: delivery.deliveryRequestId,
      ...(delivery.failureCode !== undefined && delivery.failureMessage !== undefined
        ? {
            failure: {
              code: delivery.failureCode,
              message: delivery.failureMessage,
            },
          }
        : {}),
    })),
    nextCursor,
  })
}
