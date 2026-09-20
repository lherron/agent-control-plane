/**
 * D3 — disposal keyed by RUNTIME and ledger SEQUENCE, never by run or turn.
 *
 * The rule the auto-mint left behind was "the attempt's own run started and
 * ended, so the obligations it carried have had their turn". Human-typed pane
 * turns mint no HRC run, so an obligation steered into one was invisible to
 * every path keyed on that shape — which is exactly the reader D2 now delivers
 * to by default.
 *
 * The trigger is therefore a turn TERMINAL observed for the runtime a
 * presentation landed on — `turn.completed|failed|interrupted|reaped`, run or
 * no run — and the comparison is the ledger sequence, which orders those
 * terminals against the landing without needing to know whose turn it was:
 *
 *  - undisposed, landed BEFORE this terminal, no reminder yet → arm the one
 *    60-second reminder. When it fires, `readActionableEnvelopes` picks it up
 *    and D2 delivers the pointer form through whichever door the seat is then
 *    taking, and the reminder's own landing sequence is recorded.
 *  - undisposed, and its REMINDER landed before this terminal → hold the
 *    presentation for operator review. A terminal turn is not evidence that
 *    the worker deliberately ignored the envelope: its reply write may have
 *    failed before it reached wrkq.
 *
 * "Undisposed" is read from wrkq at decision time, because the addressee may
 * have replied or deferred since; a discharged envelope terminates the record.
 * Every decision is written to the presentation row as it is MADE, so a stop or
 * a crash mid-loop leaves the reconcile a candidate rather than silence.
 */
import type { MailKickerContext } from '../context.js'
import { REMINDER_HOLD_MS, errorText } from '../internal.js'
import { newestPresentationReceipt } from '../ledger/types.js'

export type DisposalOutcome =
  | 'reminded'
  | 'held:awaiting_operator'
  | 'skipped:not_presented'
  | 'skipped:superseded'
  | 'skipped:awaiting_turn'
  | 'skipped:reminder_pending'
  | 'skipped:error'

/**
 * Dispose what one runtime was holding when a turn on it ended.
 *
 * Registered on `mailKickerDisposalsPending` so `stop()` drains it; the
 * durable per-row writes below are the second mechanism, because a drain
 * cannot cover a `kill -9`.
 */
export function disposeRuntimeObligations(
  server: MailKickerContext,
  input: {
    runtimeId: string
    targetSessionRef: string
    terminalHrcSeq: number
    terminalEventKind: string
    turnEndedAt: string
  }
): void {
  const candidates = server.store.mailDelivery.listUndisposedForRuntime(input.runtimeId)
  if (candidates.length === 0) return
  const outcomes: Record<string, DisposalOutcome> = {}

  const disposal = (async () => {
    let remindersArmed = 0
    for (const presentation of candidates) {
      try {
        const row = await server.ledger.envelopeShow({ envelope: presentation.envelopeId })
        if (row.state !== 'presented') {
          outcomes[presentation.envelopeId] = 'skipped:not_presented'
          server.store.mailDelivery.recordDisposition(
            presentation.envelopeId,
            input.runtimeId,
            `skipped:not_presented:${row.state}`
          )
          continue
        }
        // Superseded: another delivery has presented this since, so the
        // obligation is bound to that runtime and not to this one.
        if (newestPresentationReceipt(row)?.runtimeId !== input.runtimeId) {
          outcomes[presentation.envelopeId] = 'skipped:superseded'
          server.store.mailDelivery.recordDisposition(
            presentation.envelopeId,
            input.runtimeId,
            'skipped:superseded'
          )
          continue
        }
        const reminderSeq = presentation.reminderLandingHrcSeq
        if (reminderSeq !== undefined && reminderSeq < input.terminalHrcSeq) {
          // Do not infer an ignored reply from a later terminal: a `wrkc say`
          // may have failed before it committed.  The durable disposition is
          // the only claim needed here. Its conditional write makes repeated
          // terminal events idempotent and removes this row from every later
          // reminder, disposal, reinjection, and lapse candidate set.
          const held = server.store.mailDelivery.recordDisposition(
            presentation.envelopeId,
            input.runtimeId,
            'held:awaiting_operator'
          )
          outcomes[presentation.envelopeId] = 'held:awaiting_operator'
          if (held) {
            server.log('WARN', 'wrkq.kicker.obligation_held', {
              envelope: presentation.envelopeId,
              targetSessionRef: input.targetSessionRef,
              runtimeId: input.runtimeId,
              presentationId: presentation.presentationId,
              terminalEventKind: input.terminalEventKind,
              terminalHrcSeq: input.terminalHrcSeq,
              holdReason: 'reminder_landed_before_later_terminal',
            })
          }
          continue
        }
        if (reminderSeq !== undefined || presentation.reminderArmedAt !== undefined) {
          // A reminder is armed but has not landed, or landed at or after this
          // terminal. Either way this turn is not the second strike.
          outcomes[presentation.envelopeId] = 'skipped:reminder_pending'
          continue
        }
        if (presentation.landingHrcSeq >= input.terminalHrcSeq) {
          // The body landed at or after this terminal: it belongs to the turn
          // that is still to come, not the one that just ended.
          outcomes[presentation.envelopeId] = 'skipped:awaiting_turn'
          continue
        }
        const armed = server.store.mailDelivery.armReminder({
          envelopeId: presentation.envelopeId,
          runtimeId: input.runtimeId,
          turnEndedAt: input.turnEndedAt,
          remindAt: new Date(Date.now() + REMINDER_HOLD_MS).toISOString(),
        })
        if (!armed) {
          outcomes[presentation.envelopeId] = 'skipped:reminder_pending'
          continue
        }
        remindersArmed += 1
        outcomes[presentation.envelopeId] = 'reminded'
        server.log('INFO', 'wrkq.kicker.reminder_armed', {
          targetSessionRef: input.targetSessionRef,
          envelope: presentation.envelopeId,
          runtimeId: input.runtimeId,
          terminalEventKind: input.terminalEventKind,
        })
      } catch (error) {
        // Not disposing leaves the obligation alive, which is the safe
        // direction: it stays a candidate and the next terminal tries again.
        outcomes[presentation.envelopeId] = 'skipped:error'
        server.log('WARN', 'wrkq.kicker.dispose_obligation_failed', {
          targetSessionRef: input.targetSessionRef,
          envelope: presentation.envelopeId,
          runtimeId: input.runtimeId,
          error: errorText(error),
        })
      }
    }
    server.log('INFO', 'wrkq.kicker.runtime_disposal', {
      targetSessionRef: input.targetSessionRef,
      runtimeId: input.runtimeId,
      terminalEventKind: input.terminalEventKind,
      terminalHrcSeq: input.terminalHrcSeq,
      examined: candidates.length,
      remindersArmed,
      outcomes,
    })
    // An armed reminder is due 60 s from now; the sweep would find it within a
    // tick, but a wake costs nothing and is what makes the latency the spec's.
    if (remindersArmed > 0) {
      setTimeout(() => {
        if (!server.stopping) server.wake(input.targetSessionRef, 'turn_completion')
      }, REMINDER_HOLD_MS).unref?.()
    }
  })()

  server.mailKickerDisposalsPending.add(disposal)
  void disposal.finally(() => server.mailKickerDisposalsPending.delete(disposal))
}
