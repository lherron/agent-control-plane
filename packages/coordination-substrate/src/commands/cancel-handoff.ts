import type { CoordinationStore } from '../storage/open-store.js'
import { HANDOFF_STATE, type Handoff } from '../types/handoff.js'
import type { ParticipantRef } from '../types/participant-ref.js'
import { applyHandoffTransition } from './transitions.js'

export type CancelHandoffCommand = {
  handoffId: string
  by?: ParticipantRef | undefined
  cancelledAt?: string | undefined
}

export function cancelHandoff(
  store: CoordinationStore,
  command: CancelHandoffCommand
): Handoff | undefined {
  return applyHandoffTransition(store, {
    handoffId: command.handoffId,
    from: new Set([HANDOFF_STATE.open, HANDOFF_STATE.accepted]),
    to: HANDOFF_STATE.cancelled,
    at: command.cancelledAt ?? new Date().toISOString(),
  })
}
