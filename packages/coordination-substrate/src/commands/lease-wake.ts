import type { CoordinationStore } from '../storage/open-store.js'
import { getWakeById } from '../storage/records.js'
import type { WakeRequest } from '../types/wake-request.js'

export type LeaseWakeCommand = {
  wakeId: string
  leasedUntil: string
}

export function leaseWake(
  store: CoordinationStore,
  command: LeaseWakeCommand
): WakeRequest | undefined {
  return store.sqlite.transaction((input: LeaseWakeCommand) => {
    const existing = getWakeById(store.sqlite, input.wakeId)
    if (!existing || existing.state !== 'queued') {
      return undefined
    }

    store.sqlite
      .query(
        'UPDATE wake_requests SET state = ?, leased_until = ?, updated_at = ? WHERE wake_id = ?'
      )
      .run('leased', input.leasedUntil, input.leasedUntil, input.wakeId)

    return getWakeById(store.sqlite, input.wakeId)
  })(command)
}
