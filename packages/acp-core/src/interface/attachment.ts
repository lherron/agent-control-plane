export type AttachmentKind = 'url' | 'file'

export interface AttachmentRef {
  kind: AttachmentKind
  url?: string | undefined
  path?: string | undefined
  filename?: string | undefined
  contentType?: string | undefined
  sizeBytes?: number | undefined
  alt?: string | undefined
}

export type InterfaceMessageAttachment = AttachmentRef

export interface InterfaceMessagePayload {
  idempotencyKey?: string | undefined
  source: {
    gatewayId: string
    conversationRef: string
    threadRef?: string | undefined
    messageRef: string
    authorRef: string
  }
  content: string
  attachments?: InterfaceMessageAttachment[] | undefined
}
