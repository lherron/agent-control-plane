import type { SessionRef } from 'agent-scope'

import type { ParticipantRef } from './participant-ref.js'

export type CoordinationEventKind =
  | 'message.posted'
  | 'handoff.declared'
  | 'attention.requested'
  | 'artifact.linked'
  | 'system.noted'

export type CoordinationEventContent = {
  kind?: 'text' | 'markdown' | 'json' | undefined
  body?: string | undefined
}

export type CoordinationEventLinks = {
  runId?: string | undefined
  taskId?: string | undefined
  sessionId?: string | undefined
  deliveryRequestId?: string | undefined
  artifactRefs?: string[] | undefined
  conversationThreadId?: string | undefined
  conversationTurnId?: string | undefined
}

export type CoordinationEventSource = {
  gatewayId?: string | undefined
  accountRef?: string | undefined
  conversationRef?: string | undefined
  threadRef?: string | undefined
  messageRef?: string | undefined
}

export type CoordinationEvent = {
  eventId: string
  projectId: string
  seq: number
  ts: string
  kind: CoordinationEventKind
  actor?: ParticipantRef | undefined
  semanticSession?: SessionRef | undefined
  participants?: ParticipantRef[] | undefined
  content?: CoordinationEventContent | undefined
  links?: CoordinationEventLinks | undefined
  source?: CoordinationEventSource | undefined
  meta?: Record<string, unknown> | undefined
}

export type CoordinationEventInput = Omit<CoordinationEvent, 'eventId' | 'projectId' | 'seq'> & {
  eventId?: string | undefined
  projectId?: string | undefined
  seq?: number | undefined
  ts?: string | undefined
}
