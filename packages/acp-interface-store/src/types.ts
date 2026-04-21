export type InterfaceStoreActorIdentity = {
  agentId: string
  displayName?: string | undefined
}

export type InterfaceBindingStatus = 'active' | 'disabled'
export type DeliveryRequestStatus = 'queued' | 'delivering' | 'delivered' | 'failed'
export type DeliveryBodyKind = 'text/markdown'

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
  status: DeliveryRequestStatus
  createdAt: string
  deliveredAt?: string | undefined
  failureCode?: string | undefined
  failureMessage?: string | undefined
}

export type EnqueueDeliveryRequestInput = {
  deliveryRequestId: string
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
