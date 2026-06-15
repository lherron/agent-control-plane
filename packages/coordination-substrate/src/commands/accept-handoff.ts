import type { CoordinationStore } from '../storage/open-store.js'
import { HANDOFF_STATE, type Handoff } from '../types/handoff.js'
import type { ParticipantRef } from '../types/participant-ref.js'
import { applyHandoffTransition } from './transitions.js'

export type AcceptHandoffCommand = {
  handoffId: string
  by: ParticipantRef
  acceptedAt?: string | undefined
}

export function acceptHandoff(
  store: CoordinationStore,
  command: AcceptHandoffCommand
): Handoff | undefined {
  return applyHandoffTransition(store, {
    handoffId: command.handoffId,
    from: new Set([HANDOFF_STATE.open]),
    to: HANDOFF_STATE.accepted,
    at: command.acceptedAt ?? new Date().toISOString(),
  })
}
