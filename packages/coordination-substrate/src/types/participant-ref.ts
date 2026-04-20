import type { SessionRef } from 'agent-scope'

export type ParticipantRef =
  | { kind: 'agent'; agentId: string }
  | { kind: 'human'; ref: string }
  | { kind: 'session'; sessionRef: SessionRef }
  | { kind: 'interface'; gatewayId: string; conversationRef: string }
  | { kind: 'tool'; ref: string }
