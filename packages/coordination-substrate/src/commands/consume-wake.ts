import type { CoordinationStore } from '../storage/open-store.js'
import { WAKE_STATE, type WakeRequest } from '../types/wake-request.js'
import { applyWakeTransition } from './transitions.js'

export type ConsumeWakeCommand = {
  wakeId: string
  consumedAt?: string | undefined
}

export function consumeWake(
  store: CoordinationStore,
  command: ConsumeWakeCommand
): WakeRequest | undefined {
  return applyWakeTransition(store, {
    wakeId: command.wakeId,
    from: new Set([WAKE_STATE.queued, WAKE_STATE.leased]),
    to: WAKE_STATE.consumed,
    at: command.consumedAt ?? new Date().toISOString(),
    leasedUntil: null,
  })
}
