import type { CoordinationStore } from '../storage/open-store.js'
import { WAKE_STATE, type WakeRequest } from '../types/wake-request.js'
import { applyWakeTransition } from './transitions.js'

export type LeaseWakeCommand = {
  wakeId: string
  leasedUntil: string
}

export function leaseWake(
  store: CoordinationStore,
  command: LeaseWakeCommand
): WakeRequest | undefined {
  // Preserves the existing behavior where `leased_until` and `updated_at` are
  // both set to `leasedUntil` for a lease transition.
  return applyWakeTransition(store, {
    wakeId: command.wakeId,
    from: new Set([WAKE_STATE.queued]),
    to: WAKE_STATE.leased,
    at: command.leasedUntil,
    leasedUntil: command.leasedUntil,
  })
}
