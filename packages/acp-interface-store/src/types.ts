import type { Actor, AttachmentRef } from 'acp-core'

export type InterfaceStoreActorIdentity = {
  agentId: string
  displayName?: string | undefined
}

export type InterfaceBindingStatus = 'active' | 'disabled'
export type DeliveryRequestStatus = 'queued' | 'delivering' | 'delivered' | 'failed'
export type DeliveryBodyKind = 'text/markdown'
export type OutboundAttachmentState = 'pending' | 'consumed' | 'delivered' | 'failed'

export type InterfaceBinding = {
  bindingId: string
  gatewayId: string
  conversationRef: string
  threadRef?: string | undefined
  scopeRef: string
  laneRef: string
  projectId?: string | undefined
  status: InterfaceBindingStatus
  createdAt: string
  updatedAt: string
}

export type InterfaceBindingLookup = {
  gatewayId: string
  conversationRef: string
  threadRef?: string | undefined
}

export type InterfaceBindingListFilters = {
  gatewayId?: string | undefined
  conversationRef?: string | undefined
  threadRef?: string | undefined
  projectId?: string | undefined
}

export type InterfaceMessageSource = {
  gatewayId: string
  messageRef: string
  bindingId: string
  conversationRef: string
  threadRef?: string | undefined
  authorRef: string
  receivedAt: string
}

export type DeliveryRequest = {
  deliveryRequestId: string
  linkedFailureId?: string | undefined
  actor: Actor
  gatewayId: string
  bindingId: string
  scopeRef: string
  laneRef: string
  runId?: string | undefined
  inputAttemptId?: string | undefined
  conversationRef: string
  threadRef?: string | undefined
  replyToMessageRef?: string | undefined
  bodyKind: DeliveryBodyKind
  bodyText: string
  bodyAttachments?: AttachmentRef[] | undefined
  status: DeliveryRequestStatus
  createdAt: string
  deliveredAt?: string | undefined
  failureCode?: string | undefined
  failureMessage?: string | undefined
}

export type OutboundAttachment = {
  outboundAttachmentId: string
  runId: string
  state: OutboundAttachmentState
  consumedByDeliveryRequestId?: string | undefined
  path: string
  filename: string
  contentType: string
  sizeBytes: number
  alt?: string | undefined
  createdAt: string
  updatedAt: string
}

export type CreateOutboundAttachmentInput = {
  outboundAttachmentId?: string | undefined
  runId: string
  path: string
  filename: string
  contentType: string
  sizeBytes: number
  alt?: string | undefined
  createdAt?: string | undefined
}

export type EnqueueDeliveryRequestInput = {
  deliveryRequestId: string
  actor?: Actor | undefined
  gatewayId: string
  bindingId: string
  scopeRef: string
  laneRef: string
  runId?: string | undefined
  inputAttemptId?: string | undefined
  conversationRef: string
  threadRef?: string | undefined
  replyToMessageRef?: string | undefined
  bodyKind: DeliveryBodyKind
  bodyText: string
  bodyAttachments?: AttachmentRef[] | undefined
  createdAt: string
}

export type RecordIfNewMessageSourceResult = {
  created: boolean
  record: InterfaceMessageSource
}

export type DeliveryFailureInput = {
  deliveryRequestId: string
  failureCode: string
  failureMessage: string
}

export type ListFailedDeliveryRequestsInput = {
  gatewayId?: string | undefined
  since?: string | undefined
  limit?: number | undefined
}

export type RequeuedDeliveryRequest = DeliveryRequest & {
  linkedFailureId: string
  status: 'queued'
}

export type RequeueDeliveryRequestResult =
  | { ok: true; delivery: RequeuedDeliveryRequest }
  | { ok: false; code: 'wrong_state' | 'not_found' }

export type LastDeliveryRecord = {
  gatewayId: string
  conversationRef: string
  threadRef?: string | undefined
  deliveryRequestId: string
  ackedAt: string
}

export type FailedDeliveryRecord = {
  gatewayId: string
  conversationRef: string
  threadRef?: string | undefined
  deliveryRequestId: string
  failedAt: string
}

export type ResolvedDeliveryDestination = {
  gatewayId: string
  conversationRef: string
  threadRef?: string | undefined
}

export type ResolveDeliveryTargetResult =
  | { ok: true; destination: ResolvedDeliveryDestination }
  | { ok: false; code: 'not_found' | 'no_last_context' | 'invalid_target' }
