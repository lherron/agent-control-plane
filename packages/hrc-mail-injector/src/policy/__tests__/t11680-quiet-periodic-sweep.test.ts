import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { reconcileOpenIntents } from '../drive/reconcile.js'
import { driveMailTargetOnce } from '../drive/target-driver.js'
import { PERIODIC_QUIET_BACKSTOP_MS } from '../internal.js'
import { sweepLapsedObligations } from '../terminal/runtime-lapse.js'
import { periodicTargetFingerprint, recordPeriodicDrive } from '../wake/quiet-targets.js'
import { runMailKickerSweep } from '../wake/sweep.js'
import type { T08094Harness } from './t08094-harness.js'
import {
  RUNTIME_ID,
  TARGET_REF,
  createT08094Harness,
  destroyT08094Harness,
} from './t08094-harness.js'

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

describe('T-11680 periodic reconcile re-reads only intents that can still move', () => {
  function countRuntimeReads(): () => number {
    let reads = 0
    const port = h.context.port as unknown as { runtime: (id: string) => Promise<unknown> }
    const runtime = port.runtime.bind(port)
    port.runtime = async (runtimeId: string) => {
      reads += 1
      return await runtime(runtimeId)
    }
    return () => reads
  }

  function openOnGoneRuntime(envelopeId: string): void {
    h.store.mailDelivery.openIntent({
      envelopeId,
      targetSessionRef: STALE,
      door: 'enqueue',
      form: 'full',
      presentationId: `present-${envelopeId}`,
      runtimeId: 'rt-long-gone',
      submittedHrcSeq: 1,
    })
  }

  it('leaves a settled uncertain intent to the backstop on periodic passes', async () => {
    const reads = countRuntimeReads()
    openOnGoneRuntime('EN-90010')

    await reconcileOpenIntents(h.context, { reason: 'periodic' })
    expect(reads()).toBe(1)
    expect(h.store.mailDelivery.getIntent('EN-90010')?.uncertainCause).toBe(
      'runtime_terminated_before_landing'
    )

    await reconcileOpenIntents(h.context, { reason: 'periodic' })
    await reconcileOpenIntents(h.context, { reason: 'periodic' })
    expect(reads()).toBe(1)

    const examinedAt = h.context.mailKickerReconcileExaminedAt.get('EN-90010')
    if (examinedAt === undefined) throw new Error('reconcile memo missing')
    h.context.mailKickerReconcileExaminedAt.set('EN-90010', examinedAt - PERIODIC_QUIET_BACKSTOP_MS)
    await reconcileOpenIntents(h.context, { reason: 'periodic' })
    expect(reads()).toBe(2)
  })

  it('still examines every intent at daemon start and on runtime termination', async () => {
    const reads = countRuntimeReads()
    openOnGoneRuntime('EN-90011')
    await reconcileOpenIntents(h.context, { reason: 'periodic' })
    expect(reads()).toBe(1)

    await reconcileOpenIntents(h.context, { reason: 'daemon_start' })
    expect(reads()).toBe(2)
    await reconcileOpenIntents(h.context, {
      reason: 'runtime_terminated',
      runtimeIds: new Set(['rt-long-gone']),
    })
    expect(reads()).toBe(3)
  })

  it('keeps examining an in-flight intent and a runtime-read timeout every pass', async () => {
    const reads = countRuntimeReads()
    h.store.mailDelivery.openIntent({
      envelopeId: 'EN-90012',
      targetSessionRef: TARGET_REF,
      door: 'enqueue',
      form: 'full',
      presentationId: 'present-EN-90012',
      runtimeId: RUNTIME_ID,
      submittedHrcSeq: 1,
    })
    await reconcileOpenIntents(h.context, { reason: 'periodic' })
    await reconcileOpenIntents(h.context, { reason: 'periodic' })
    expect(reads()).toBe(2)

    h.store.mailDelivery.markUncertain(
      'EN-90012',
      'reconcile_runtime_read_timeout',
      'runtime_read_timeout'
    )
    await reconcileOpenIntents(h.context, { reason: 'periodic' })
    expect(reads()).toBe(3)
  })
})

describe('T-11680 lapse sweep re-reads a live runtime at the backstop', () => {
  it('inspects a live presentation runtime once, then again only at the backstop', async () => {
    let reads = 0
    const port = h.context.port as unknown as { runtime: (id: string) => Promise<unknown> }
    const runtime = port.runtime.bind(port)
    port.runtime = async (runtimeId: string) => {
      reads += 1
      return await runtime(runtimeId)
    }
    h.store.mailDelivery.recordPresentation({
      envelopeId: 'EN-90020',
      runtimeId: RUNTIME_ID,
      targetSessionRef: TARGET_REF,
      generation: 1,
      presentationId: 'present-EN-90020',
      deliveryOutcome: 'steered',
      landingHrcSeq: 10,
    })

    await sweepLapsedObligations(h.context)
    await sweepLapsedObligations(h.context)
    await sweepLapsedObligations(h.context)
    expect(reads).toBe(1)

    const seenLiveAt = h.context.mailKickerLiveRuntimeSeenAt.get(RUNTIME_ID)
    if (seenLiveAt === undefined) throw new Error('live-runtime memo missing')
    h.context.mailKickerLiveRuntimeSeenAt.set(RUNTIME_ID, seenLiveAt - PERIODIC_QUIET_BACKSTOP_MS)
    await sweepLapsedObligations(h.context)
    expect(reads).toBe(2)
  })
})
