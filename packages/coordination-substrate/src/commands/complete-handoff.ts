import type { CoordinationStore } from '../storage/open-store.js'
import { getHandoffById } from '../storage/records.js'
import type { Handoff } from '../types/handoff.js'
import type { ParticipantRef } from '../types/participant-ref.js'

export type CompleteHandoffCommand = {
  handoffId: string
  by?: ParticipantRef | undefined
  completedAt?: string | undefined
}

export function completeHandoff(
  store: CoordinationStore,
  command: CompleteHandoffCommand
): Handoff | undefined {
  return store.sqlite.transaction((input: CompleteHandoffCommand) => {
    const existing = getHandoffById(store.sqlite, input.handoffId)
    if (!existing || existing.state !== 'accepted') {
      return undefined
    }

    const completedAt = input.completedAt ?? new Date().toISOString()
    store.sqlite
      .query('UPDATE handoffs SET state = ?, updated_at = ? WHERE handoff_id = ?')
      .run('completed', completedAt, input.handoffId)

    return getHandoffById(store.sqlite, input.handoffId)
  })(command)
}
