import type { SessionRef } from 'agent-scope'

import type { ParticipantRef } from './participant-ref.js'

export type HandoffKind =
  | 'review'
  | 'approval'
  | 'delivery'
  | 'tool-wait'
  | 'human-wait'
  | 'blocked'

export type HandoffState = 'open' | 'accepted' | 'completed' | 'cancelled'

export type Handoff = {
  handoffId: string
  projectId: string
  sourceEventId: string
  taskId?: string | undefined
  from?: ParticipantRef | undefined
  to?: ParticipantRef | undefined
  targetSession?: SessionRef | undefined
  kind: HandoffKind
  reason?: string | undefined
  state: HandoffState
  createdAt: string
  updatedAt: string
}

export type HandoffInput = Omit<
  Handoff,
  'handoffId' | 'projectId' | 'sourceEventId' | 'createdAt' | 'updatedAt' | 'state'
> & {
  state?: HandoffState | undefined
}
