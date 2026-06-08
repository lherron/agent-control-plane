import type { CoordinationStore } from '../storage/open-store.js'
import { getWakeById } from '../storage/records.js'
import { WAKE_STATE, type WakeRequest } from '../types/wake-request.js'

export type ConsumeWakeCommand = {
  wakeId: string
  consumedAt?: string | undefined
}

export function consumeWake(
  store: CoordinationStore,
  command: ConsumeWakeCommand
): WakeRequest | undefined {
  return store.sqlite.transaction((input: ConsumeWakeCommand) => {
    const existing = getWakeById(store.sqlite, input.wakeId)
    if (
      !existing ||
      (existing.state !== WAKE_STATE.queued && existing.state !== WAKE_STATE.leased)
    ) {
      return undefined
    }

    const consumedAt = input.consumedAt ?? new Date().toISOString()
    store.sqlite
      .query(
        'UPDATE wake_requests SET state = ?, leased_until = NULL, updated_at = ? WHERE wake_id = ?'
      )
      .run(WAKE_STATE.consumed, consumedAt, input.wakeId)

    return getWakeById(store.sqlite, input.wakeId)
  })(command)
}
