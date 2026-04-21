export interface InterfaceMessageSource {
  gatewayId: string
  bindingId: string
  conversationRef: string
  threadRef?: string | undefined
  messageRef: string
  authorRef: string
  receivedAt: string
}
