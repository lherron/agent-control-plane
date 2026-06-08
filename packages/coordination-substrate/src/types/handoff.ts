import type { SessionRef } from 'agent-scope'

import type { ParticipantRef } from './participant-ref.js'

export type HandoffKind =
  | 'review'
  | 'approval'
  | 'delivery'
  | 'tool-wait'
  | 'human-wait'
  | 'blocked'

export const HANDOFF_STATE = {
  open: 'open',
  accepted: 'accepted',
  completed: 'completed',
  cancelled: 'cancelled',
} as const

export type HandoffState = (typeof HANDOFF_STATE)[keyof typeof HANDOFF_STATE]

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
