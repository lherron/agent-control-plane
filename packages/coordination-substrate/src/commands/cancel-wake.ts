import type { CoordinationStore } from '../storage/open-store.js'
import { getWakeById } from '../storage/records.js'
import type { WakeRequest } from '../types/wake-request.js'

export type CancelWakeCommand = {
  wakeId: string
  cancelledAt?: string | undefined
}

export function cancelWake(
  store: CoordinationStore,
  command: CancelWakeCommand
): WakeRequest | undefined {
  return store.sqlite.transaction((input: CancelWakeCommand) => {
    const existing = getWakeById(store.sqlite, input.wakeId)
    if (!existing || (existing.state !== 'queued' && existing.state !== 'leased')) {
      return undefined
    }

    const cancelledAt = input.cancelledAt ?? new Date().toISOString()
    store.sqlite
      .query(
        'UPDATE wake_requests SET state = ?, leased_until = NULL, updated_at = ? WHERE wake_id = ?'
      )
      .run('cancelled', cancelledAt, input.wakeId)

    return getWakeById(store.sqlite, input.wakeId)
  })(command)
}
