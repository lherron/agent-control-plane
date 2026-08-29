import type {
  Actor,
  AttachmentRef,
  DeliveryOutcome as CoreDeliveryOutcome,
  DeliveryRequestStatus as CoreDeliveryRequestStatus,
} from 'acp-core'

export type InterfaceStoreActorIdentity = {
  agentId: string
  displayName?: string | undefined
}

export type InterfaceBindingStatus = 'active' | 'disabled'

export interface DiscordLedgerProjectionRoute {
  gatewayId: string
  roomUuid: string
  roomKey: string
  bindingId: string
  conversationRef: string
  threadRef?: string | undefined
  humanPrincipalRef: string
  updatedAt: string
}

export type RecordDiscordLedgerProjectionRouteInput = Omit<
  DiscordLedgerProjectionRoute,
  'updatedAt'
>

export type DiscordLedgerDeliveryState = 'attempting' | 'sent' | 'failed'

/** Identity of one delivery: a single envelope aimed at a single sink. */
export interface DiscordLedgerDeliveryKey {
  gatewayId: string
  envelopeId: string
  sink: string
}

export interface DiscordLedgerDelivery extends DiscordLedgerDeliveryKey {
  /** Discord channel the attempt targets; reconciliation reads it back. */
  channelId: string
  /** Set for route-scoped sinks, so the row prunes with its binding. */
  bindingId?: string | undefined
  state: DiscordLedgerDeliveryState
  discordMessageId?: string | undefined
  attempts: number
  failureReason?: string | undefined
  updatedAt: string
}

export interface BeginDiscordLedgerDeliveryAttemptInput extends DiscordLedgerDeliveryKey {
  channelId: string
  bindingId?: string | undefined
  /** Ceiling on total attempts for this (envelope, sink). */
  maxAttempts: number
}

/**
 * `attempting` - the attempt was durably claimed; send now.
 * `exhausted`  - the budget ran out and the row is now `failed`; never resent.
 * `terminal`   - the row was already `sent` or `failed`; do not send.
 */
export type BeginDiscordLedgerDeliveryAttemptResult = {
  outcome: 'attempting' | 'exhausted' | 'terminal'
  delivery: DiscordLedgerDelivery
}

export type DeliveryRequestStatus = CoreDeliveryRequestStatus
export type DeliveryBodyKind = 'text/markdown'

export type DeliveryOutcome = CoreDeliveryOutcome
export type OutboundAttachmentState = 'pending' | 'consumed' | 'delivered' | 'failed'

export type InterfaceBinding = {
  bindingId: string
  gatewayId: string
  gatewayType: string
  conversationRef: string
  threadRef?: string | undefined
  scopeRef: string
  laneRef: string
  projectId?: string | undefined
  agentId?: string | undefined
  taskId?: string | undefined
  roleName?: string | undefined
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
  gatewayType?: string | undefined
  conversationRef?: string | undefined
  threadRef?: string | undefined
  projectId?: string | undefined
  agentId?: string | undefined
  laneRef?: string | undefined
  status?: InterfaceBindingStatus | undefined
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
  outcome?: DeliveryOutcome | undefined
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
  outcome?: DeliveryOutcome | undefined
  createdAt: string
}

export type EnqueueDeliveryRequestIdempotencyInput = EnqueueDeliveryRequestInput & {
  route: string
  idempotencyKey: string
  fingerprintHash: string
}

export type EnqueueDeliveryRequestIdempotencyResult =
  | { ok: true; created: true; delivery: DeliveryRequest }
  | { ok: true; created: false; delivery: DeliveryRequest }
  | {
      ok: false
      code: 'idempotency_conflict' | 'delivery_not_found'
      existingDeliveryRequestId?: string | undefined
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
