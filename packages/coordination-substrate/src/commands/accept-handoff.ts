import type { CoordinationStore } from '../storage/open-store.js'
import { getHandoffById } from '../storage/records.js'
import type { Handoff } from '../types/handoff.js'
import type { ParticipantRef } from '../types/participant-ref.js'

export type AcceptHandoffCommand = {
  handoffId: string
  by: ParticipantRef
  acceptedAt?: string | undefined
}

export function acceptHandoff(
  store: CoordinationStore,
  command: AcceptHandoffCommand
): Handoff | undefined {
  return store.sqlite.transaction((input: AcceptHandoffCommand) => {
    const existing = getHandoffById(store.sqlite, input.handoffId)
    if (!existing || existing.state !== 'open') {
      return undefined
    }

    const acceptedAt = input.acceptedAt ?? new Date().toISOString()
    store.sqlite
      .query('UPDATE handoffs SET state = ?, updated_at = ? WHERE handoff_id = ?')
      .run('accepted', acceptedAt, input.handoffId)

    return getHandoffById(store.sqlite, input.handoffId)
  })(command)
}
