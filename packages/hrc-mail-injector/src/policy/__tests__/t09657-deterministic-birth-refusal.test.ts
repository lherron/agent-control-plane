/**
 * T-09657 — a DETERMINISTIC birth refusal fails the summons at once, and the
 * sender is told why.
 *
 * HRC types a caller-fixable placement fact (a task-named worktree whose branch
 * names another task, …) as 422 `declaration_invalid`. Retrying it is a fifteen
 * minute spin that ends in a bare "undeliverable": nothing about the target
 * changes between sweeps. Transient refusals keep the rev 5.1 D7 backoff.
 *
 * Failure modes this guards:
 *  - the 422 is charged as one more transient strike (sender waits ~15 min);
 *  - the envelope fails but the refusal row stays open, so the sweep re-drives;
 *  - the failure reaches wrkq without the HRC reason, so the notice says nothing;
 *  - a transient refusal is mistaken for deterministic and fails mail at once;
 *  - the 5-strike path still fails without saying why.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { HrcDomainError, HrcErrorCode } from 'hrc-core'

import { driveMailTargetOnce } from '../drive/target-driver.js'
import { BIRTH_SWEEP_MAX_REFUSALS } from '../internal.js'
import { formatEnvelopeFailureNotice } from '../ledger/presentation.js'
import { queueFailureNotice } from '../terminal/failure-notices.js'
import { chargeBirthSweepRefusal } from '../wake/birth-retry.js'
import {
  SCOPE_REF,
  type T08094Harness,
  TARGET_REF,
  createT08094Harness,
  destroyT08094Harness,
} from './t08094-harness.js'

const REFUSAL =
  'worktree at /w/arris-T-09539 appears associated with T-09539 but branch feature/T-01234 does not carry T-09539'

let h: T08094Harness

beforeEach(async () => {
  h = await createT08094Harness()
  // A never-born target: nothing live on this node, so D7 has authority.
  h.context.port.allRuntimes = async () => []
})

afterEach(async () => {
  await destroyT08094Harness(h)
})

function refuseBirthWith(error: Error): void {
  h.context.port.ensureTargetSession = async () => {
    throw error
  }
}

function events(name: string) {
  return h.logs.filter((entry) => entry.event === name)
}

describe('T-09657 — deterministic birth refusal', () => {
  it('fails the pending summons undeliverable in the same drive, with the HRC reason', async () => {
    const envelope = h.ledger.say()
    refuseBirthWith(
      new HrcDomainError(HrcErrorCode.DECLARATION_INVALID, REFUSAL, { source: 'task-worktree' })
    )

    const outcome = await driveMailTargetOnce(h.context, TARGET_REF, 'insert')

    expect(outcome).toEqual({ outcome: 'undeliverable', failed: 1 })
    expect(events('wrkq.kicker.drive_completed')[0]?.detail).toMatchObject({
      outcome: 'undeliverable',
      terminalized: 1,
      stillPending: 0,
      recovery: 'sender_notice',
    })
    expect(h.ledger.failRequests).toEqual([
      { envelope: envelope.id, reason: 'undeliverable', detail: expect.stringContaining(REFUSAL) },
    ])
    // The row is resolved, so the periodic sweep does not re-drive it.
    expect(h.db.mailDelivery.listRefusedBirthTargets()).not.toContain(TARGET_REF)
    expect(h.context.mailKickerBirthSweepBackoff.has(TARGET_REF)).toBe(false)
    expect(events('wrkq.kicker.unborn_birth_retry')).toHaveLength(0)
    expect(events('wrkq.kicker.birth_refusal_deterministic')[0]?.detail).toMatchObject({
      targetSessionRef: TARGET_REF,
      code: 'declaration_invalid',
      source: 'task-worktree',
    })
  })

  it('does not fail an envelope already presented elsewhere', async () => {
    const presented = h.ledger.say()
    presented.presentedTo.push({ memberRef: SCOPE_REF, presentedAt: new Date().toISOString() })
    const pending = h.ledger.say()
    refuseBirthWith(new HrcDomainError(HrcErrorCode.DECLARATION_INVALID, REFUSAL, {}))

    await driveMailTargetOnce(h.context, TARGET_REF, 'insert')

    expect(h.ledger.failRequests.map((request) => request.envelope)).toEqual([pending.id])
  })

  it('CONTROL: a transient refusal keeps the backoff path and fails nothing', async () => {
    h.ledger.say()
    refuseBirthWith(
      new HrcDomainError(HrcErrorCode.RUNTIME_UNAVAILABLE, 'broker start timed out', {})
    )

    const outcome = await driveMailTargetOnce(h.context, TARGET_REF, 'periodic')
    expect(outcome).toMatchObject({ outcome: 'birth-refused' })
    await chargeBirthSweepRefusal(h.context, TARGET_REF)

    expect(h.ledger.failRequests).toHaveLength(0)
    expect(h.db.mailDelivery.listRefusedBirthTargets()).toContain(TARGET_REF)
    expect(events('wrkq.kicker.unborn_birth_retry')[0]?.detail).toMatchObject({
      targetSessionRef: TARGET_REF,
      attempt: 1,
    })
  })

  it('the 5-strike path tells the sender the last refusal reason', async () => {
    const envelope = h.ledger.say()
    h.db.mailDelivery.recordBirthRefusal({
      targetSessionRef: TARGET_REF,
      scopeRef: SCOPE_REF,
      reason: 'broker start timed out',
    })
    h.context.mailKickerBirthSweepBackoff.set(TARGET_REF, {
      attempts: BIRTH_SWEEP_MAX_REFUSALS - 1,
      nextAtMs: 0,
    })

    await chargeBirthSweepRefusal(h.context, TARGET_REF)

    expect(h.ledger.failRequests).toEqual([
      {
        envelope: envelope.id,
        reason: 'undeliverable',
        detail: expect.stringContaining('broker start timed out'),
      },
    ])
  })
})

describe('T-09657 — sender notice carries the failure detail', () => {
  it('renders detail into the undeliverable notice', () => {
    const envelope = h.ledger.say()
    const notice = formatEnvelopeFailureNotice(envelope, 'undeliverable', {
      detail: `HRC refused the birth: ${REFUSAL}`,
    })
    expect(notice).toContain('failed: undeliverable')
    expect(notice).toContain(REFUSAL)
  })

  it('reads detail from the envelope.failed payload', async () => {
    const envelope = h.ledger.say({
      from: { principalRef: 'agent:clod', scopeRef: SCOPE_REF },
    })
    await queueFailureNotice(h.context, {
      resourceId: envelope.id,
      payload: JSON.stringify({ state: 'failed', reason: 'undeliverable', detail: REFUSAL }),
    } as never)

    const [queued] = h.db.mailDelivery.listUndeliveredFailureNotices(TARGET_REF)
    expect(queued?.notice).toContain(REFUSAL)
  })
})
