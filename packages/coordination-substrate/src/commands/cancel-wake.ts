import type { CoordinationStore } from '../storage/open-store.js'
import { WAKE_STATE, type WakeRequest } from '../types/wake-request.js'
import { applyWakeTransition } from './transitions.js'

export type CancelWakeCommand = {
  wakeId: string
  cancelledAt?: string | undefined
}

export function cancelWake(
  store: CoordinationStore,
  command: CancelWakeCommand
): WakeRequest | undefined {
  return applyWakeTransition(store, {
    wakeId: command.wakeId,
    from: new Set([WAKE_STATE.queued, WAKE_STATE.leased]),
    to: WAKE_STATE.cancelled,
    at: command.cancelledAt ?? new Date().toISOString(),
    leasedUntil: null,
  })
}
