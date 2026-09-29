import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { observeBrokerLanding } from '../drive/landing.js'
import { reconcileOpenIntents } from '../drive/reconcile.js'
import { STEER_WRITE_RECONCILE_GRACE_MS } from '../internal.js'
import type { T08094Harness } from './t08094-harness.js'
import {
  RUNTIME_ID as RUNTIME,
  createT08094Harness,
  deliverOneTo,
  destroyT08094Harness,
  seatIn,
} from './t08094-harness.js'

/**
 * T-09875 — a steer written into a LIVE turn is a landing.
 *
 * The broker emits `input.accepted {disposition: 'attempted_steer'}` only after
 * the driver's `applySteerNow` resolved, i.e. the body is in the turn the reader
 * is already in. `submission.absorbed` is a later, best-effort correlation of
 * the echoed user row: Codex never emits it and Claude emits it only when its
 * hook row carries the input id. Waiting for it alone left the receipt unwritten
 * and fyi mail TTL-failed as a false `undeliverable` (EN-20851, EN-20888).
 */

const INVOCATION = 'inv-t09875'
let h: T08094Harness

beforeEach(async () => {
  h = await createT08094Harness()
  const now = new Date().toISOString()
  h.db.brokerInvocations.insert({
    invocationId: INVOCATION,
    operationId: 'op-t09875',
    runtimeId: RUNTIME,
    brokerProtocol: 'harness-broker/0.2',
    brokerDriver: 'codex-app-server',
    invocationState: 'turn_active',
    capabilitiesJson: JSON.stringify({ admission: { classes: ['steer', 'queue'] } }),
    specHash: 'spec',
    startRequestHash: 'sr',
    selectedProfileHash: 'pf',
    createdAt: now,
    updatedAt: now,
  })
  h.db.runtimes.update(RUNTIME, { activeInvocationId: INVOCATION, updatedAt: now })
  // The turn the fyi steers into: brokerAfterSeq for the intent is 5.
  append(5, 'turn.started', { turnId: 'turn-1' })
})

afterEach(async () => {
  await destroyT08094Harness(h)
})

function record(seq: number, type: string, payload: Record<string, unknown>) {
  return {
    invocationId: INVOCATION,
    seq,
    time: new Date().toISOString(),
    type,
    runtimeId: RUNTIME,
    brokerEventJson: JSON.stringify(payload),
    projectionStatus: 'projected',
    createdAt: new Date().toISOString(),
  }
}

function append(seq: number, type: string, payload: Record<string, unknown>) {
  h.db.brokerInvocationEvents.appendEvent({
    invocationId: INVOCATION,
    runtimeId: RUNTIME,
    seq,
    time: new Date().toISOString(),
    type,
    payload,
  })
}

const attemptedSteer = (seq: number) =>
  record(seq, 'input.accepted', { inputId: 'sub-1', disposition: 'attempted_steer' })

describe('T-09875 — mid-turn steer receipt', () => {
  it('records a steered presentation when the harness accepts a mid-turn fyi', async () => {
    const fyi = h.ledger.say({ obligation: 'fyi' })
    await deliverOneTo(h, seatIn('turn-active'), fyi)

    await observeBrokerLanding(h.context, attemptedSteer(7))

    const receipts = h.ledger.envelopes.get(fyi.id)?.presentedTo ?? []
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({ runtimeId: RUNTIME, deliveryOutcome: 'steered' })
    expect(h.db.mailDelivery.getIntent(fyi.id)).toBeUndefined()

    // The later correlation, when the driver manages one, is not a second receipt.
    await observeBrokerLanding(
      h.context,
      record(9, 'submission.absorbed', { submissionId: 'sub-1', turnId: 'turn-1' })
    )
    expect(h.ledger.envelopes.get(fyi.id)?.presentedTo).toHaveLength(1)
  })

  it('lands a write the observer sees before the steer response is recorded', async () => {
    const fyi = h.ledger.say({ obligation: 'fyi' })
    // The broker applies a busy steer asynchronously, so its admission and
    // attempted_steer can commit and be followed before `deliverToSeat` has
    // attached the submission id the door returned.
    h.context.port.steer = async () => {
      await observeBrokerLanding(
        h.context,
        record(6, 'admission.requested', {
          submissionId: 'sub-1',
          class: 'steer',
          origin: { envelopeId: fyi.id },
        })
      )
      await observeBrokerLanding(h.context, attemptedSteer(7))
      return h.dispatchResult()
    }

    expect(await deliverOneTo(h, seatIn('turn-active'), fyi)).toBe('submitted')

    expect(h.ledger.envelopes.get(fyi.id)?.presentedTo).toHaveLength(1)
    expect(h.ledger.envelopes.get(fyi.id)?.presentedTo[0]?.deliveryOutcome).toBe('steered')
    expect(h.db.mailDelivery.getIntent(fyi.id)).toBeUndefined()
  })

  it('does not bind an admission from before the intent was opened', async () => {
    const fyi = h.ledger.say({ obligation: 'fyi' })
    h.context.port.steer = async () => {
      // seq 4 precedes the intent's broker cursor (5): an older submission.
      await observeBrokerLanding(
        h.context,
        record(4, 'admission.requested', {
          submissionId: 'sub-old',
          class: 'steer',
          origin: { envelopeId: fyi.id },
        })
      )
      return h.dispatchResult()
    }
    await deliverOneTo(h, seatIn('turn-active'), fyi)
    expect(h.db.mailDelivery.getIntent(fyi.id)?.submissionId).toBe('sub-1')
  })

  it('reconciles a stranded mid-turn write into exactly one steered receipt', async () => {
    const fyi = h.ledger.say({ obligation: 'fyi' })
    await deliverOneTo(h, seatIn('turn-active'), fyi)
    // The observer never saw it (the population EN-20888 belongs to).
    append(7, 'input.accepted', { inputId: 'sub-1', disposition: 'attempted_steer' })

    // Inside the grace a write is still expected to be correlated live.
    expect(await reconcileOpenIntents(h.context, { reason: 'periodic' })).toMatchObject({
      open: 1,
    })
    h.db.sqlite
      .query('UPDATE hrcmail_delivery_intents SET submitted_at = ? WHERE envelope_id = ?')
      .run(new Date(Date.now() - STEER_WRITE_RECONCILE_GRACE_MS - 1_000).toISOString(), fyi.id)

    expect(await reconcileOpenIntents(h.context, { reason: 'periodic' })).toMatchObject({
      landed: 1,
    })
    expect(h.ledger.envelopes.get(fyi.id)?.presentedTo).toHaveLength(1)
    expect(h.ledger.envelopes.get(fyi.id)?.presentedTo[0]?.deliveryOutcome).toBe('steered')
    await reconcileOpenIntents(h.context, { reason: 'periodic' })
    expect(h.ledger.envelopes.get(fyi.id)?.presentedTo).toHaveLength(1)
  })

  it('never lands a write that the producer proved was not written', async () => {
    const fyi = h.ledger.say({ obligation: 'fyi' })
    await deliverOneTo(h, seatIn('turn-active'), fyi)
    append(7, 'input.accepted', { inputId: 'sub-1', disposition: 'started' })
    append(8, 'input.rejected', {
      inputId: 'sub-1',
      reason: 'pane_not_quiescent',
      deliveryEvidence: 'not_written',
    })
    h.db.sqlite
      .query('UPDATE hrcmail_delivery_intents SET submitted_at = ? WHERE envelope_id = ?')
      .run(new Date(Date.now() - STEER_WRITE_RECONCILE_GRACE_MS - 1_000).toISOString(), fyi.id)

    await reconcileOpenIntents(h.context, { reason: 'periodic' })
    expect(h.ledger.envelopes.get(fyi.id)?.presentedTo).toHaveLength(0)
  })

  it('keeps the idle path: a started input lands only on its execution', async () => {
    const fyi = h.ledger.say({ obligation: 'fyi' })
    await deliverOneTo(h, seatIn('idle'), fyi)

    await observeBrokerLanding(
      h.context,
      record(7, 'input.accepted', { inputId: 'sub-1', disposition: 'started' })
    )
    expect(h.ledger.envelopes.get(fyi.id)?.presentedTo).toHaveLength(0)

    await observeBrokerLanding(
      h.context,
      record(8, 'submission.executed', { submissionId: 'sub-1', turnId: 'turn-2' })
    )
    expect(h.ledger.envelopes.get(fyi.id)?.presentedTo).toHaveLength(1)
    expect(h.ledger.envelopes.get(fyi.id)?.presentedTo[0]?.deliveryOutcome).toBe('executed')
  })

  it('a reply that discharged the envelope first leaves no receipt and no failure', async () => {
    const request = h.ledger.say()
    await deliverOneTo(h, seatIn('turn-active'), request)
    const row = h.ledger.envelopes.get(request.id)
    if (row === undefined) throw new Error('missing row')
    row.state = 'acked'
    row.terminal = true

    await observeBrokerLanding(h.context, attemptedSteer(7))
    expect(row.presentedTo).toHaveLength(0)
    expect(h.ledger.failRequests).toEqual([])
  })
})
