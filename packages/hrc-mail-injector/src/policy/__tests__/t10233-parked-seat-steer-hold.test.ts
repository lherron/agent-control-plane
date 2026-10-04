import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { observeBrokerLanding } from '../drive/landing.js'
import { driveMailTargetOnce } from '../drive/target-driver.js'
import { STEER_HOLD_MAX_MS } from '../internal.js'
import {
  RUNTIME_ID as RUNTIME,
  TARGET_REF as TARGET,
  createT08094Harness,
  destroyT08094Harness,
} from './t08094-harness.js'
import type { T08094Harness } from './t08094-harness.js'

/**
 * T-10233 — a seat parked on human input must not cost an HRC submission per
 * retry.
 *
 * Every steer the kicker sends is a new HRC submission and run. A seat parked on
 * an AskUserQuestion refuses each one `pane_not_quiescent` / `not_written`, and
 * the kicker used to re-steer every envelope on every backoff tick: ~11,300
 * submissions on one invocation in a morning (mable@wrkq:primary, 2026-10-04).
 *
 * The kicker now holds steer delivery while (a) the runtime says
 * `awaiting_input`, or (b) the seat's last refusal was `pane_not_quiescent`
 * proven unwritten and nothing has happened on the seat since. Either hold ends
 * when that state changes, and the envelope then lands as usual.
 */

const INVOCATION = 'inv-t10233'
let h: T08094Harness
let steers: number
let nextSeq: number

beforeEach(async () => {
  h = await createT08094Harness()
  const now = new Date().toISOString()
  h.db.brokerInvocations.insert({
    invocationId: INVOCATION,
    operationId: 'op-t10233',
    runtimeId: RUNTIME,
    brokerProtocol: 'harness-broker/0.2',
    brokerDriver: 'claude-code',
    invocationState: 'turn_active',
    capabilitiesJson: JSON.stringify({ admission: { classes: ['steer', 'queue'] } }),
    specHash: 'spec',
    startRequestHash: 'sr',
    selectedProfileHash: 'pf',
    createdAt: now,
    updatedAt: now,
  })
  h.db.runtimes.update(RUNTIME, {
    controllerKind: 'harness-broker',
    activeInvocationId: INVOCATION,
    updatedAt: now,
  })
  nextSeq = 1
  append('turn.started', { turnId: 'turn-1' })
  h.context.port.seat = async () => ({
    runtimeId: RUNTIME,
    invocationId: INVOCATION,
    generation: 1,
    admissionClasses: ['steer', 'queue'],
    currentBrokerSeq: h.db.brokerInvocationEvents.maxBrokerSeq(INVOCATION),
    probe: {
      invocationId: INVOCATION as never,
      seat: { state: 'turn-active', turnId: 'turn-1' as never },
      brokerHeldDepth: 0,
    },
    probeError: null,
  })
  steers = 0
  // Each steer is a fresh submission, exactly as HRC mints one per admission.
  h.context.port.steer = async () => {
    steers += 1
    const submissionId = `sub-${steers}`
    append('admission.requested', { submissionId, class: 'steer' })
    append('admission.admitted', { submissionId, class: 'steer' })
    return { ...h.dispatchResult(), submissionId }
  }
})

afterEach(async () => {
  await destroyT08094Harness(h)
})

function append(type: string, payload: Record<string, unknown>): number {
  const seq = nextSeq++
  h.db.brokerInvocationEvents.appendEvent({
    invocationId: INVOCATION,
    runtimeId: RUNTIME,
    seq,
    time: new Date().toISOString(),
    type,
    payload,
  })
  return seq
}

/** Commit one broker event and feed it to the kicker's observer, as the subscription does. */
async function observe(type: string, payload: Record<string, unknown>): Promise<void> {
  const seq = append(type, payload)
  await observeBrokerLanding(h.context, {
    invocationId: INVOCATION,
    seq,
    time: new Date().toISOString(),
    type,
    runtimeId: RUNTIME,
    brokerEventJson: JSON.stringify(payload),
    projectionStatus: 'projected',
    createdAt: new Date().toISOString(),
  })
}

/**
 * The broker refuses the open steer unwritten because the pane is not quiet.
 * It commits the refusal as a PAIR, `input.rejected` then `submission.rejected`
 * (live: seq 35/36 on rt-ea5f117a), and the second one is bookkeeping, not the
 * seat moving.
 */
async function refusePaneNotQuiescent(submissionId: string): Promise<void> {
  await observe('input.rejected', {
    inputId: submissionId,
    reason: 'pane_not_quiescent',
    deliveryEvidence: 'not_written',
  })
  await observe('submission.rejected', { submissionId, reason: 'pane_not_quiescent' })
}

function setRuntimeStatus(status: 'awaiting_input' | 'busy'): void {
  h.db.runtimes.update(RUNTIME, { status, updatedAt: new Date().toISOString() })
}

describe('T-10233 — steer hold on a seat parked on human input', () => {
  it('sends nothing into an awaiting_input runtime, and steers once it resumes', async () => {
    const request = h.ledger.say()
    setRuntimeStatus('awaiting_input')

    for (let tick = 0; tick < 10; tick++) {
      await driveMailTargetOnce(h.context, TARGET, 'periodic')
    }
    expect(steers).toBe(0)
    expect(h.db.mailDelivery.getIntent(request.id)).toBeUndefined()
    expect(h.logs.filter((log) => log.event === 'wrkq.kicker.steer_held')).toHaveLength(1)
    expect(h.logs.find((log) => log.event === 'wrkq.kicker.steer_held')?.detail).toMatchObject({
      runtimeId: RUNTIME,
      hold: 'awaiting_input',
    })

    // The human answered: the turn resumes and the mail goes in.
    setRuntimeStatus('busy')
    await driveMailTargetOnce(h.context, TARGET, 'periodic')
    expect(steers).toBe(1)
    expect(h.db.mailDelivery.getIntent(request.id)?.door).toBe('steer')
  })

  it('does not re-steer a pane_not_quiescent refusal while nothing happens on the seat', async () => {
    const request = h.ledger.say()
    await driveMailTargetOnce(h.context, TARGET, 'insert')
    expect(steers).toBe(1)
    await refusePaneNotQuiescent('sub-1')
    expect(h.db.mailDelivery.getIntent(request.id)).toBeUndefined()

    for (let tick = 0; tick < 10; tick++) {
      await driveMailTargetOnce(h.context, TARGET, 'periodic')
    }
    expect(steers).toBe(1)
    expect(h.logs.find((log) => log.event === 'wrkq.kicker.steer_held')?.detail).toMatchObject({
      runtimeId: RUNTIME,
      hold: 'pane_not_quiescent',
    })

    // A driver notice ("Claude is waiting for your input") is not the reader.
    await observe('driver.notice', { message: 'Claude is waiting for your input' })
    await driveMailTargetOnce(h.context, TARGET, 'periodic')
    expect(steers).toBe(1)

    // The reader answered: the turn moved on, and the mail goes in.
    await observe('tool.call.completed', { toolCallId: 'toolu-ask', turnId: 'turn-1' })
    await driveMailTargetOnce(h.context, TARGET, 'periodic')
    expect(steers).toBe(2)
  })

  it('re-probes a quiet pane once the hold ceiling passes, at most once per ceiling', async () => {
    h.ledger.say()
    await driveMailTargetOnce(h.context, TARGET, 'insert')
    await refusePaneNotQuiescent('sub-1')
    await driveMailTargetOnce(h.context, TARGET, 'periodic')
    expect(steers).toBe(1)

    const hold = h.context.mailKickerSteerHold.get(RUNTIME)
    if (hold === undefined) throw new Error('expected a steer hold')
    hold.since -= STEER_HOLD_MAX_MS + 1
    await driveMailTargetOnce(h.context, TARGET, 'periodic')
    expect(steers).toBe(2)

    await refusePaneNotQuiescent('sub-2')
    for (let tick = 0; tick < 5; tick++) {
      await driveMailTargetOnce(h.context, TARGET, 'periodic')
    }
    expect(steers).toBe(2)
  })

  it('clears the hold when a body lands on the runtime', async () => {
    // Two envelopes in one pass: two steers, sub-1 and sub-2.
    h.ledger.say()
    h.ledger.say()
    await driveMailTargetOnce(h.context, TARGET, 'insert')
    expect(steers).toBe(2)
    await refusePaneNotQuiescent('sub-1')
    expect(h.context.mailKickerSteerHold.get(RUNTIME)?.reason).toBe('pane_not_quiescent')

    // sub-2 was written into the turn after all: the seat takes bodies again.
    await observe('input.accepted', { inputId: 'sub-2', disposition: 'attempted_steer' })
    expect(h.context.mailKickerSteerHold.has(RUNTIME)).toBe(false)
  })
})
