import type { AttachmentRef } from './attachment.js'
import type { InterfaceSessionRef } from './binding.js'

export type DeliveryRequestStatus = 'queued' | 'delivering' | 'delivered' | 'failed'

export interface DeliveryRequestBody {
  kind: 'text/markdown'
  text: string
  attachments?: AttachmentRef[] | undefined
}

export type DeliveryOutcome =
  | { state: 'normal' }
  | {
      state: 'degraded'
      reason: 'no_assistant_content'
      source?: 'launch_exit_synthesized' | 'codex_app_server' | 'codex_jsonl' | string | undefined
    }
  | {
      state: 'degraded'
      reason: 'launch_signalled'
      source?: string | undefined
      signal: string
    }
  | {
      state: 'degraded'
      reason: 'launch_failed'
      source?: string | undefined
      exitCode: number
    }

export interface DeliveryFailure {
  code: string
  message: string
}

export interface DeliveryRequest {
  deliveryRequestId: string
  gatewayId: string
  bindingId: string
  sessionRef: InterfaceSessionRef
  runId?: string | undefined
  inputAttemptId?: string | undefined
  conversationRef: string
  threadRef?: string | undefined
  replyToMessageRef?: string | undefined
  body: DeliveryRequestBody
  outcome?: DeliveryOutcome | undefined
  status: DeliveryRequestStatus
  createdAt: string
  deliveredAt?: string | undefined
  failure?: DeliveryFailure | undefined
}

export function isTerminal(status: DeliveryRequestStatus): boolean {
  return status === 'delivered' || status === 'failed'
}

export function canAck(status: DeliveryRequestStatus): boolean {
  return !isTerminal(status)
}

export function canFail(status: DeliveryRequestStatus): boolean {
  return !isTerminal(status)
}
