/**
 * Hold steer delivery while a seat is parked on human input (T-10233).
 *
 * Every steer the kicker sends is a new HRC submission and a new run. A seat
 * parked on an AskUserQuestion refuses each one `pane_not_quiescent` with
 * `not_written`, and the retry that refusal earns used to re-admit every
 * pending envelope on every backoff tick: ~11,300 submissions and as many runs
 * on one invocation in a morning (mable@wrkq:primary, 2026-10-04), each with a
 * `broker.submission.stalled` warning.
 *
 * Two facts say the seat is parked, and either one holds the steer:
 *
 *  - the runtime's own status is `awaiting_input` (HRC's ask bracket). The hold
 *    lasts exactly as long as that status;
 *  - the seat's last steer was refused `pane_not_quiescent`, proven unwritten,
 *    and the reader has not moved since. The kicker's own broker observer
 *    decides "moved": any committed event on the runtime except the refusal
 *    bookkeeping a steer leaves behind (the broker commits `input.rejected`
 *    AND `submission.rejected` per refusal) and driver notices — so the
 *    answer, a tool call, a new turn or a new invocation ends it. So does
 *    `STEER_HOLD_MAX_MS`, which buys ONE re-probe for the change the broker
 *    cannot see (a person who typed into the prompt and cleared it).
 *
 * A held pass submits nothing and opens no intent, so the envelope stays
 * pending and the periodic sweep re-drives it; the first pass after the hold
 * ends delivers it through the ordinary door. Process-local like the other
 * steer memos: a restart that forgets a hold costs one refused steer, which
 * re-arms it.
 */
import type { HrcBrokerInvocationEventRecord } from 'hrc-core'

import type { MailKickerContext, SteerHold } from '../context.js'
import { STEER_HOLD_MAX_MS, errorText } from '../internal.js'
import type { ObservedBrokerSeat } from './seat.js'

export type SteerHoldReason = SteerHold['reason']

/**
 * Arm the quiet-pane hold from a `pane_not_quiescent` refusal proven unwritten.
 *
 * `observed` is the refusal's own broker record when the live observer saw it.
 * A refusal found by reconcile has none, so the seat's current head stands in:
 * that can only fold in events that happened after the refusal, which makes the
 * hold end later than it could have, never sooner than it should.
 */
export async function armQuietPaneHold(
  server: MailKickerContext,
  runtimeId: string,
  observed?: { invocationId: string; brokerSeq: number }
): Promise<void> {
  let at = observed
  if (at === undefined) {
    try {
      const seat = await server.port.seat(runtimeId)
      if (seat.invocationId === null || seat.currentBrokerSeq === null) return
      at = { invocationId: seat.invocationId, brokerSeq: seat.currentBrokerSeq }
    } catch (error) {
      // No head, no hold: the ordinary backoff still paces the retry.
      server.log('INFO', 'wrkq.kicker.steer_hold_unarmed', {
        runtimeId,
        error: errorText(error),
      })
      return
    }
  }
  const prior = server.mailKickerSteerHold.get(runtimeId)
  if (
    prior?.reason === 'pane_not_quiescent' &&
    prior.invocationId === at.invocationId &&
    prior.brokerSeq >= at.brokerSeq
  ) {
    return
  }
  server.mailKickerSteerHold.set(runtimeId, {
    reason: 'pane_not_quiescent',
    invocationId: at.invocationId,
    brokerSeq: at.brokerSeq,
    // A later refusal on the same quiet pane extends the stream position, not
    // the ceiling: the clock runs from the first refusal of this hold.
    since:
      prior?.reason === 'pane_not_quiescent' && prior.invocationId === at.invocationId
        ? prior.since
        : Date.now(),
    announced: prior?.reason === 'pane_not_quiescent' ? prior.announced : false,
  })
}

/** A body landed on this runtime: whatever held it is over. */
export function clearSteerHold(server: MailKickerContext, runtimeId: string): void {
  server.mailKickerSteerHold.delete(runtimeId)
}

/**
 * Is steer delivery into this seat held right now, and why?
 *
 * Only a steer-capable live seat is ever held: an enqueue is admitted once and
 * waits in the broker for the turn boundary, so it has no retry loop to stop.
 */
export function steerHoldFor(
  server: MailKickerContext,
  seat: ObservedBrokerSeat
): SteerHoldReason | undefined {
  if ((seat.state !== 'idle' && seat.state !== 'turn-active') || !seat.steerCapable) return
  const runtimeId = seat.runtimeId
  const hold = server.mailKickerSteerHold.get(runtimeId)

  if (seat.awaitingInput === true) {
    if (hold?.reason !== 'awaiting_input') {
      server.mailKickerSteerHold.set(runtimeId, {
        reason: 'awaiting_input',
        invocationId: null,
        brokerSeq: 0,
        since: Date.now(),
        announced: true,
      })
      server.log('INFO', 'wrkq.kicker.steer_held', { runtimeId, hold: 'awaiting_input' })
    }
    return 'awaiting_input'
  }
  if (hold === undefined) return

  const release = (cause: string) => {
    server.mailKickerSteerHold.delete(runtimeId)
    server.log('INFO', 'wrkq.kicker.steer_hold_released', {
      runtimeId,
      hold: hold.reason,
      cause,
      heldMs: Date.now() - hold.since,
    })
  }
  if (hold.reason === 'awaiting_input') {
    release('input_resumed')
    return
  }
  if (Date.now() - hold.since >= STEER_HOLD_MAX_MS) {
    release('ceiling')
    return
  }
  if (!hold.announced) {
    hold.announced = true
    server.log('INFO', 'wrkq.kicker.steer_held', {
      runtimeId,
      hold: hold.reason,
      invocationId: hold.invocationId,
      brokerSeq: hold.brokerSeq,
    })
  }
  return 'pane_not_quiescent'
}

/**
 * Events a steer attempt and its refusal leave on the stream, and harness
 * notices. None of them is the reader doing anything.
 */
const NOT_SEAT_MOVEMENT = new Set([
  'admission.requested',
  'admission.admitted',
  'admission.rejected',
  'input.rejected',
  'submission.rejected',
  'driver.notice',
])

/**
 * Release a quiet-pane hold when the seat moves (called for every committed
 * broker event the kicker observes).
 *
 * Driven by the observer rather than by comparing broker heads, because the
 * head also moves on the refusal's own `submission.rejected`, which commits
 * right after the `input.rejected` that armed the hold: a head comparison read
 * that as movement and re-steered on the next pass (live, rt-ea5f117a).
 */
export function observeSeatActivity(
  server: MailKickerContext,
  record: Pick<HrcBrokerInvocationEventRecord, 'runtimeId' | 'invocationId' | 'seq' | 'type'>
): void {
  const hold = server.mailKickerSteerHold.get(record.runtimeId)
  if (hold?.reason !== 'pane_not_quiescent') return
  if (record.invocationId === hold.invocationId) {
    if (record.seq <= hold.brokerSeq || NOT_SEAT_MOVEMENT.has(record.type)) return
  }
  server.mailKickerSteerHold.delete(record.runtimeId)
  server.log('INFO', 'wrkq.kicker.steer_hold_released', {
    runtimeId: record.runtimeId,
    hold: hold.reason,
    cause: record.invocationId === hold.invocationId ? 'seat_moved' : 'invocation_changed',
    brokerEventType: record.type,
    brokerSeq: record.seq,
    heldAtSeq: hold.brokerSeq,
    heldMs: Date.now() - hold.since,
  })
}
