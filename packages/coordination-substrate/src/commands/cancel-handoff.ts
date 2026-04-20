import type { CoordinationStore } from '../storage/open-store.js'
import { getHandoffById } from '../storage/records.js'
import type { Handoff } from '../types/handoff.js'
import type { ParticipantRef } from '../types/participant-ref.js'

export type CancelHandoffCommand = {
  handoffId: string
  by?: ParticipantRef | undefined
  cancelledAt?: string | undefined
}

export function cancelHandoff(
  store: CoordinationStore,
  command: CancelHandoffCommand
): Handoff | undefined {
  return store.sqlite.transaction((input: CancelHandoffCommand) => {
    const existing = getHandoffById(store.sqlite, input.handoffId)
    if (!existing || (existing.state !== 'open' && existing.state !== 'accepted')) {
      return undefined
    }

    const cancelledAt = input.cancelledAt ?? new Date().toISOString()
    store.sqlite
      .query('UPDATE handoffs SET state = ?, updated_at = ? WHERE handoff_id = ?')
      .run('cancelled', cancelledAt, input.handoffId)

    return getHandoffById(store.sqlite, input.handoffId)
  })(command)
}
