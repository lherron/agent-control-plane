import type { SessionRef } from 'agent-scope'

export type DeliveryTarget =
  | { kind: 'binding'; bindingId: string }
  | { kind: 'last'; sessionRef: SessionRef }
  | {
      kind: 'explicit'
      gatewayId: string
      conversationRef: string
      threadRef?: string | undefined
    }
