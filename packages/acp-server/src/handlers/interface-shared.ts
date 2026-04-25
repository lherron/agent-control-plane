import type {
  DeliveryRequest as ApiDeliveryRequest,
  InterfaceBinding as ApiInterfaceBinding,
} from 'acp-core'
import type {
  DeliveryRequest as StoredDeliveryRequest,
  InterfaceBinding as StoredInterfaceBinding,
} from 'acp-interface-store'

import { AcpHttpError, badRequest, notFound } from '../http.js'

type DeliveryCursor = {
  createdAt: string
  runId: string
  deliveryRequestId: string
}

export function requireGatewayId(params: Record<string, string>): string {
  const gatewayId = params['gatewayId']
  if (gatewayId === undefined || gatewayId.length === 0) {
    badRequest('gatewayId route param is required', { field: 'gatewayId' })
  }

  return gatewayId
}

export function requireDeliveryRequestId(params: Record<string, string>): string {
  const deliveryRequestId = params['deliveryRequestId']
  if (deliveryRequestId === undefined || deliveryRequestId.length === 0) {
    badRequest('deliveryRequestId route param is required', { field: 'deliveryRequestId' })
  }

  return deliveryRequestId
}

export function parseInterfaceBindingStatus(value: unknown): ApiInterfaceBinding['status'] {
  if (value === undefined) {
    return 'active'
  }

  if (value !== 'active' && value !== 'disabled') {
    badRequest('status must be "active" or "disabled"', { field: 'status' })
  }

  return value
}

export function toApiInterfaceBinding(binding: StoredInterfaceBinding): ApiInterfaceBinding {
  return {
    bindingId: binding.bindingId,
    gatewayId: binding.gatewayId,
    conversationRef: binding.conversationRef,
    ...(binding.threadRef !== undefined ? { threadRef: binding.threadRef } : {}),
    sessionRef: {
      scopeRef: binding.scopeRef,
      laneRef: binding.laneRef,
    },
    ...(binding.projectId !== undefined ? { projectId: binding.projectId } : {}),
    status: binding.status,
    createdAt: binding.createdAt,
    updatedAt: binding.updatedAt,
  }
}

export function toApiDeliveryRequest(delivery: StoredDeliveryRequest): ApiDeliveryRequest {
  const failure =
    delivery.failureCode !== undefined && delivery.failureMessage !== undefined
      ? {
          code: delivery.failureCode,
          message: delivery.failureMessage,
        }
      : undefined

  return {
    deliveryRequestId: delivery.deliveryRequestId,
    ...(delivery.linkedFailureId !== undefined
      ? { linkedFailureId: delivery.linkedFailureId }
      : {}),
    gatewayId: delivery.gatewayId,
    bindingId: delivery.bindingId,
    sessionRef: {
      scopeRef: delivery.scopeRef,
      laneRef: delivery.laneRef,
    },
    ...(delivery.runId !== undefined ? { runId: delivery.runId } : {}),
    ...(delivery.inputAttemptId !== undefined ? { inputAttemptId: delivery.inputAttemptId } : {}),
    conversationRef: delivery.conversationRef,
    ...(delivery.threadRef !== undefined ? { threadRef: delivery.threadRef } : {}),
    ...(delivery.replyToMessageRef !== undefined
      ? { replyToMessageRef: delivery.replyToMessageRef }
      : {}),
    body: {
      kind: delivery.bodyKind,
      text: delivery.bodyText,
      ...(delivery.bodyAttachments !== undefined ? { attachments: delivery.bodyAttachments } : {}),
    },
    status: delivery.status,
    createdAt: delivery.createdAt,
    ...(delivery.deliveredAt !== undefined ? { deliveredAt: delivery.deliveredAt } : {}),
    ...(failure !== undefined ? { failure } : {}),
  }
}

export function requireDeliveryForTransition(
  delivery: StoredDeliveryRequest | undefined,
  deliveryRequestId: string
): StoredDeliveryRequest {
  if (delivery === undefined) {
    notFound(`delivery request not found: ${deliveryRequestId}`, { deliveryRequestId })
  }

  return delivery
}

export function requireAckableDelivery(delivery: StoredDeliveryRequest): void {
  if (delivery.status !== 'queued' && delivery.status !== 'delivering') {
    throw new AcpHttpError(
      422,
      'delivery_not_ackable',
      `delivery request ${delivery.deliveryRequestId} cannot be acked from status ${delivery.status}`,
      {
        deliveryRequestId: delivery.deliveryRequestId,
        status: delivery.status,
      }
    )
  }
}

export function requireFailurableDelivery(delivery: StoredDeliveryRequest): void {
  if (delivery.status !== 'queued' && delivery.status !== 'delivering') {
    throw new AcpHttpError(
      422,
      'delivery_not_failurable',
      `delivery request ${delivery.deliveryRequestId} cannot be failed from status ${delivery.status}`,
      {
        deliveryRequestId: delivery.deliveryRequestId,
        status: delivery.status,
      }
    )
  }
}

export function compareDeliveriesForStream(
  left: Pick<StoredDeliveryRequest, 'createdAt' | 'runId' | 'deliveryRequestId'>,
  right: Pick<StoredDeliveryRequest, 'createdAt' | 'runId' | 'deliveryRequestId'>
): number {
  return (
    left.createdAt.localeCompare(right.createdAt) ||
    (left.runId ?? '').localeCompare(right.runId ?? '') ||
    left.deliveryRequestId.localeCompare(right.deliveryRequestId)
  )
}

export function encodeDeliveryCursor(
  delivery: Pick<StoredDeliveryRequest, 'createdAt' | 'runId' | 'deliveryRequestId'>
): string {
  return [delivery.createdAt, delivery.runId ?? '', delivery.deliveryRequestId].join('|')
}

export function parseDeliveryCursor(value: string | undefined): DeliveryCursor | undefined {
  if (value === undefined) {
    return undefined
  }

  const parts = value.split('|')
  if (parts.length !== 3 || parts[0]?.length === 0 || parts[2]?.length === 0) {
    badRequest('since must be a valid delivery cursor', { field: 'since' })
  }

  return {
    createdAt: parts[0] as string,
    runId: parts[1] as string,
    deliveryRequestId: parts[2] as string,
  }
}

export function isDeliveryAfterCursor(
  delivery: Pick<StoredDeliveryRequest, 'createdAt' | 'runId' | 'deliveryRequestId'>,
  cursor: DeliveryCursor
): boolean {
  return (
    compareDeliveriesForStream(delivery, {
      createdAt: cursor.createdAt,
      runId: cursor.runId,
      deliveryRequestId: cursor.deliveryRequestId,
    }) > 0
  )
}
