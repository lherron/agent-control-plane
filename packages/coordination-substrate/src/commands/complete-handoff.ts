import type { CoordinationStore } from '../storage/open-store.js'
import { HANDOFF_STATE, type Handoff } from '../types/handoff.js'
import type { ParticipantRef } from '../types/participant-ref.js'
import { applyHandoffTransition } from './transitions.js'

export type CompleteHandoffCommand = {
  handoffId: string
  by?: ParticipantRef | undefined
  completedAt?: string | undefined
}

export function completeHandoff(
  store: CoordinationStore,
  command: CompleteHandoffCommand
): Handoff | undefined {
  return applyHandoffTransition(store, {
    handoffId: command.handoffId,
    from: new Set([HANDOFF_STATE.accepted]),
    to: HANDOFF_STATE.completed,
    at: command.completedAt ?? new Date().toISOString(),
  })
}
