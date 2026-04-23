import type { SessionRef } from 'agent-scope'

/**
 * High-level message participant kinds for /v1/coordination/messages.
 *
 * These are the PUBLIC API shapes — the handler maps them to the
 * internal coordination-substrate ParticipantRef before persisting.
 */
export type MessageParticipantHuman = {
  kind: 'human'
  humanId?: string | undefined
  displayName?: string | undefined
}

export type MessageParticipantAgent = {
  kind: 'agent'
  agentId: string
}

export type MessageParticipantSessionRef = {
  kind: 'sessionRef'
  sessionRef: SessionRef
}

export type MessageParticipantSystem = {
  kind: 'system'
}

export type MessageParticipant =
  | MessageParticipantHuman
  | MessageParticipantAgent
  | MessageParticipantSessionRef
  | MessageParticipantSystem

export const messageParticipantKinds = ['human', 'agent', 'sessionRef', 'system'] as const

export type CoordinationMessageOptions = {
  wake?: boolean | undefined
  dispatch?: boolean | undefined
  coordinationOnly?: boolean | undefined
}

export type CoordinationMessageInput = {
  projectId: string
  from: MessageParticipant
  to: MessageParticipant
  body: string | { kind: string; body: unknown }
  options?: CoordinationMessageOptions | undefined
}
