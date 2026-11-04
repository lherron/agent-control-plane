/**
 * The 300-second recovery backstop behind insert/lifecycle wakes and the
 * deferral deadline timer. Bounded pendingView batches include scopes this node
 * homes, seats, or owes a birth for. Homed but unseated recipients matter after
 * a restart: their deferred envelopes are absent from pendingView until the
 * global lazy repend runs, and their deferral events may predate our cursor.
 * The startup catch-up and persisted tail remain the immediate recovery paths.
 */
import type { MailKickerContext } from '../context.js'
import { reportBootReconcileOnce, reportStalledDeliveries } from '../diagnostics/stranded.js'
import { reconcileOpenIntents } from '../drive/reconcile.js'
import { hrcFacts } from '../facts/hrc-facts.js'
import { LEDGER_SWEEP_SCOPE_BATCH, errorText } from '../internal.js'
import { WrkqLedgerUnavailableError } from '../ledger/client.js'
import { sweepLapsedObligations } from '../terminal/runtime-lapse.js'
import { unbornBirthWakeCandidates } from './birth-retry.js'
import { chunk, collectPendingTargets, homedTargetSessionRefs } from './cold-start.js'
import { selectChangedPeriodicTargets } from './quiet-targets.js'

export function runMailKickerSweep(this: MailKickerContext): Promise<void> {
  if (!this.enabled || this.stopping) return Promise.resolve()
  if (this.mailKickerSweepInFlight !== undefined) return this.mailKickerSweepInFlight

  const sweep = (async () => {
    // T-07963 criterion 2: ACT before reporting. The reconcile disposes what it
    // can truthfully dispose — a terminal runtime's obligation, and a carried
    // turn's D4/D5 lifecycle — so what T-07964's line then names is the set an
    // operator actually has to do something about, rather than a list the
    // daemon quietly fixed a second later. Both are boot-once and both run
    // after warmup, so they see the same reattached world.
    // D2 step 5's PERIODIC leg. An intent whose landing this daemon never saw
    // — a broker that went away, an observer that dropped, a crash between the
    // door and the receipt — is resolved against the mirrored stream here, and
    // its envelope becomes actionable again or gets its receipt.
    await reconcileOpenIntents(this, { reason: 'periodic' }).catch((error: unknown) => {
      this.log('WARN', 'wrkq.kicker.intent_reconcile_failed', { error: errorText(error) })
    })
    // T-07964 §4: one boot report, on the first periodic sweep rather than at
    // `start()`, so runtime reattachment and the broker's warmup have already
    // happened and the runs it names are the ones that really did survive.
    await reportBootReconcileOnce(this)
    // Every sweep, but at most one line per attempt per process: a wedge does
    // not clear on its own, so a seat that stalls between boots must not stay
    // silent until the next one.
    await reportStalledDeliveries(this).catch((error: unknown) => {
      this.log('WARN', 'wrkq.kicker.stalled_delivery_check_failed', { error: errorText(error) })
    })
    // rev 5.1 D3 backstop. Ahead of the delivery sweep on purpose: an
    // obligation that has already lapsed should be failed before the same tick
    // reads the wake set, so the sender's notice and the reader's next
    // presentation cannot cross.
    await sweepLapsedObligations(this)
    // A restart can miss envelope.deferred events: repend globally even when
    // there are no seats or owed births to supply a scope batch below.
    try {
      await this.ledger.pendingView({ scopes: [] })
    } catch (error) {
      this.log('WARN', 'wrkq.kicker.sweep_repend_failed', { error: errorText(error) })
    }
    const now = new Date().toISOString()
    // Outstanding business, driven every sweep: a due D4 reminder, and pending
    // mail for a seated or owed-birth scope. Neither a reminder nor a §5 notice
    // shows up as pending mail, so without the local sources below a scope
    // whose only outstanding business is one of them is never woken at all.
    const outstanding = new Set<string>(this.store.mailDelivery.listDueReminderTargets(now))
    // Keyed to the lifecycle follow (T-12430): re-read only after a runtime or
    // session event, a resume, or with no follow attached.
    const seated = await hrcFacts(this).liveSessionRefs()
    const unborn = await unbornBirthWakeCandidates(this, seated)
    // Deferred recipients may be homed here with no live runtime. They are
    // absent from the unborn list too: a restart that missed their deferral
    // event must still discover the repended envelope within this backstop.
    const homed = await homedTargetSessionRefs(this)
    const recipients = [...new Set([...seated, ...unborn, ...homed])]
    for (const batch of chunk(recipients, LEDGER_SWEEP_SCOPE_BATCH)) {
      try {
        // includeFyi here too: a seated addressee should be shown a fyi on the
        // next sweep, which is §5's "otherwise on X's next attend".
        const view = await this.ledger.pendingView({ scopes: batch, includeFyi: true })
        if (view.repended > 0) {
          this.log('INFO', 'wrkq.kicker.deferrals_repended', { repended: view.repended })
        }
        collectPendingTargets(view.items, outstanding)
      } catch (error) {
        this.log(
          error instanceof WrkqLedgerUnavailableError ? 'WARN' : 'ERROR',
          'wrkq.kicker.sweep_pending_view_failed',
          { scopes: batch.length, error: errorText(error) }
        )
        break
      }
    }
    // Local state only — an open intent, a §5 notice waiting for its sender's
    // next attend. These are driven when that state changed since their last
    // drive found nothing (T-11680), not on every sweep.
    const local = new Set<string>()
    for (const target of this.store.mailDelivery.listIntentTargets()) local.add(target)
    for (const target of this.store.mailDelivery.listFailureNoticeTargets()) local.add(target)
    for (const target of outstanding) local.delete(target)
    const targets = new Set<string>(outstanding)
    for (const target of selectChangedPeriodicTargets(this, local, new Set(seated))) {
      targets.add(target)
    }
    for (const targetSessionRef of targets) {
      this.mailKickerPendingTargets.set(targetSessionRef, 'periodic')
    }
    // A target drive may legitimately wait on a cold birth or a busy broker.
    // It owns its own serialization and re-kick handling, so it must not also
    // hold this whole periodic pass open: doing so suppresses the next intent
    // reconciliation, including recovery of a landing the live observer saw
    // before the dispatch response made its submission id durable.
    for (const targetSessionRef of targets) {
      void this.drainTarget(targetSessionRef).catch((error: unknown) => {
        this.log('WARN', 'wrkq.kicker.sweep_target_drive_failed', {
          targetSessionRef,
          error: errorText(error),
        })
      })
    }
    this.log('INFO', 'wrkq.kicker.sweep_complete', { targets: targets.size })
  })().finally(() => {
    if (this.mailKickerSweepInFlight === sweep) this.mailKickerSweepInFlight = undefined
  })
  this.mailKickerSweepInFlight = sweep
  return sweep
}
