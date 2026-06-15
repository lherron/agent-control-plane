import type { CoordinationStore } from '../storage/open-store.js'
import { getHandoffById, getWakeById } from '../storage/records.js'
import type { Handoff, HandoffState } from '../types/handoff.js'
import type { WakeRequest, WakeRequestState } from '../types/wake-request.js'

export type HandoffTransition = {
  handoffId: string
  /** States the handoff is allowed to move out of. */
  from: ReadonlySet<HandoffState>
  /** State the handoff moves into. */
  to: HandoffState
  /** Timestamp written to `updated_at`. */
  at: string
}

/**
 * Shared handoff state-machine transition: open a transaction, fetch by id,
 * guard that the current state is in `from` (returning `undefined` otherwise,
 * matching every per-command illegal-transition / missing-id contract), apply
 * the `UPDATE handoffs SET state, updated_at`, then re-fetch and return.
 * Handoff transitions never touch `leased_until`.
 */
export function applyHandoffTransition(
  store: CoordinationStore,
  transition: HandoffTransition
): Handoff | undefined {
  return store.sqlite.transaction((input: HandoffTransition) => {
    const existing = getHandoffById(store.sqlite, input.handoffId)
    if (!existing || !input.from.has(existing.state)) {
      return undefined
    }

    store.sqlite
      .query('UPDATE handoffs SET state = ?, updated_at = ? WHERE handoff_id = ?')
      .run(input.to, input.at, input.handoffId)

    return getHandoffById(store.sqlite, input.handoffId)
  })(transition)
}

export type WakeTransition = {
  wakeId: string
  /** States the wake is allowed to move out of. */
  from: ReadonlySet<WakeRequestState>
  /** State the wake moves into. */
  to: WakeRequestState
  /** Timestamp written to `updated_at`. */
  at: string
  /**
   * Value written to `leased_until`. `null` clears the lease (consume/cancel);
   * a string sets it (lease). For `leaseWake` this is the same value as `at`,
   * preserving the existing `leased_until == updated_at` behavior.
   */
  leasedUntil: string | null
}

/**
 * Shared wake state-machine transition. Mirrors {@link applyHandoffTransition}
 * but always writes the `leased_until` column (set on lease, NULL on
 * consume/cancel).
 */
export function applyWakeTransition(
  store: CoordinationStore,
  transition: WakeTransition
): WakeRequest | undefined {
  return store.sqlite.transaction((input: WakeTransition) => {
    const existing = getWakeById(store.sqlite, input.wakeId)
    if (!existing || !input.from.has(existing.state)) {
      return undefined
    }

    store.sqlite
      .query(
        'UPDATE wake_requests SET state = ?, leased_until = ?, updated_at = ? WHERE wake_id = ?'
      )
      .run(input.to, input.leasedUntil, input.at, input.wakeId)

    return getWakeById(store.sqlite, input.wakeId)
  })(transition)
}
