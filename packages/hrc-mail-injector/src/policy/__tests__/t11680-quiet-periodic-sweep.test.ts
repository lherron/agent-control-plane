import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { driveMailTargetOnce } from '../drive/target-driver.js'
import { PERIODIC_QUIET_BACKSTOP_MS } from '../internal.js'
import { periodicTargetFingerprint, recordPeriodicDrive } from '../wake/quiet-targets.js'
import { runMailKickerSweep } from '../wake/sweep.js'
import type { T08094Harness } from './t08094-harness.js'
import { TARGET_REF, createT08094Harness, destroyT08094Harness } from './t08094-harness.js'

/**
 * T-11680: the periodic sweep drives a target only for outstanding mail or a
 * changed state. Before it, every target holding a stale intent or an
 * undeliverable notice was re-driven every 30 seconds, three HRC reads each,
 * and every one of those drives ended empty.
 */

const STALE = 'agent:cody:project:agent-control-plane:task:T-stale/lane:main'

let h: T08094Harness
let drained: string[]
let driveOutcome: Parameters<typeof recordPeriodicDrive>[2]

beforeEach(async () => {
  h = await createT08094Harness()
  drained = []
  driveOutcome = { outcome: 'empty' }
  h.context.drainTarget = async (targetSessionRef) => {
    drained.push(targetSessionRef)
    recordPeriodicDrive(h.context, targetSessionRef, driveOutcome)
  }
})

afterEach(async () => {
  await destroyT08094Harness(h)
})

async function sweep(): Promise<string[]> {
  drained = []
  await runMailKickerSweep.call(h.context)
  return drained
}

function owe(envelopeId: string): void {
  h.store.mailDelivery.recordFailureNotice({
    envelopeId,
    targetSessionRef: STALE,
    notice: 'sender failure',
  })
}

describe('T-11680 periodic sweep drives outstanding mail or changed state only', () => {
  it('drives an unchanged notice-only target once, then leaves it alone', async () => {
    owe('EN-90001')
    expect(await sweep()).toContain(STALE)
    expect(await sweep()).not.toContain(STALE)
    expect(await sweep()).not.toContain(STALE)
  })

  it('keeps driving a seated target with pending mail on every sweep', async () => {
    h.ledger.say()
    expect(await sweep()).toContain(TARGET_REF)
    expect(await sweep()).toContain(TARGET_REF)
  })

  it('re-drives a quiet target on a new notice, a due notice backoff, or the backstop', async () => {
    owe('EN-90001')
    await sweep()
    expect(await sweep()).not.toContain(STALE)

    owe('EN-90002')
    expect(await sweep()).toContain(STALE)
    expect(await sweep()).not.toContain(STALE)

    h.context.mailKickerFailureNoticeBackoff.set(STALE, {
      key: 'notice-key',
      parked: false,
      attempts: 1,
      nextAtMs: Date.now() - 1,
    })
    expect(await sweep()).toContain(STALE)
    h.context.mailKickerFailureNoticeBackoff.delete(STALE)
    expect(await sweep()).not.toContain(STALE)

    const quiet = h.context.mailKickerQuietTargets.get(STALE)
    if (quiet === undefined) throw new Error('quiet memo missing')
    quiet.quietSinceMs -= PERIODIC_QUIET_BACKSTOP_MS
    expect(await sweep()).toContain(STALE)
  })

  it('does not go quiet on a drive that did anything but find nothing', async () => {
    owe('EN-90001')
    driveOutcome = undefined
    await sweep()
    expect(await sweep()).toContain(STALE)
  })

  it('ignores the timestamp reconcile rewrites, not a changed intent', () => {
    h.store.mailDelivery.openIntent({
      envelopeId: 'EN-90003',
      targetSessionRef: STALE,
      door: 'steer',
      form: 'full',
      presentationId: 'present-90003',
      submittedHrcSeq: 1,
    })
    const seated = new Set<string>()
    const before = periodicTargetFingerprint(h.context, STALE, seated)

    h.storeSql
      .query('UPDATE hrcmail_delivery_intents SET updated_at = ? WHERE envelope_id = ?')
      .run('2099-01-01T00:00:00.000Z', 'EN-90003')
    expect(periodicTargetFingerprint(h.context, STALE, seated)).toBe(before)

    h.storeSql
      .query('UPDATE hrcmail_delivery_intents SET uncertain_cause = ? WHERE envelope_id = ?')
      .run('ttl_without_landing', 'EN-90003')
    expect(periodicTargetFingerprint(h.context, STALE, seated)).not.toBe(before)
    expect(periodicTargetFingerprint(h.context, STALE, new Set([STALE]))).not.toBe(
      periodicTargetFingerprint(h.context, STALE, seated)
    )
  })

  it('reports an empty drive so the sweep can tell nothing was outstanding', async () => {
    expect(await driveMailTargetOnce(h.context, TARGET_REF, 'periodic')).toEqual({
      outcome: 'empty',
    })
  })
})
