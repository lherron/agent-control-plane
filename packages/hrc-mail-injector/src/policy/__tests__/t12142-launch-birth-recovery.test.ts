import { afterEach, beforeEach, expect, it } from 'bun:test'
import { join } from 'node:path'
import { reportStalledDeliveries } from '../diagnostics/stranded.js'
import { readActionableEnvelopes } from '../drive/presentation.js'
import { driveMailTargetOnce } from '../drive/target-driver.js'
import { STALLED_DELIVERY_THRESHOLD_MS } from '../internal.js'
import { openKickerStateStore } from '../kicker-state-store.js'
import {
  TARGET_REF as TARGET,
  createT08094Harness,
  destroyT08094Harness,
} from './t08094-harness.js'
import type { T08094Harness } from './t08094-harness.js'

let h: T08094Harness
beforeEach(async () => {
  h = await createT08094Harness()
})
afterEach(async () => {
  await destroyT08094Harness(h)
})

it('releases a failed launch and fails only that envelope after three births', async () => {
  const envelope = h.ledger.say()
  const sibling = h.ledger.say()
  h.context.port.targetBySessionRef = async () => undefined
  h.context.port.invoke = async () => {
    throw new Error('launch-carried submission identity timed out')
  }
  h.context.port.allRuntimes = async () => []
  for (let attempt = 1; attempt <= 3; attempt++) {
    // Allow the existing scope backoff to expire between drives.
    h.context.mailKickerBirthSweepBackoff.clear()
    await driveMailTargetOnce(h.context, TARGET, 'periodic')
    expect(h.store.mailDelivery.getIntent(envelope.id)).toBeUndefined()
    if (attempt < 3) {
      expect(
        (await readActionableEnvelopes(h.context, TARGET)).map((x) => x.envelope.id)
      ).toContain(envelope.id)
      expect(h.ledger.failRequests).toHaveLength(0)
    }
  }
  expect(h.ledger.envelopes.get(sibling.id)?.state).toBe('pending')
  expect(h.ledger.failRequests).toEqual([
    {
      envelope: envelope.id,
      reason: 'undeliverable',
      detail: 'birth_failed: launch-carried submission identity timed out',
    },
  ])
})

it('recovers a stalled launch once the scope loses its live runtime, even after warning', async () => {
  const envelope = h.ledger.say()
  h.store.mailDelivery.openIntent({
    envelopeId: envelope.id,
    targetSessionRef: TARGET,
    door: 'launch',
    form: 'full',
    presentationId: 'stalled-launch',
    submittedHrcSeq: 0,
  })
  h.storeSql
    .query('UPDATE hrcmail_delivery_intents SET submitted_at = ?')
    .run(new Date(Date.now() - STALLED_DELIVERY_THRESHOLD_MS - 1000).toISOString())
  await reportStalledDeliveries(h.context)
  expect(h.store.mailDelivery.getIntent(envelope.id)).toBeDefined()
  h.context.port.allRuntimes = async () => []
  await reportStalledDeliveries(h.context)
  expect(h.store.mailDelivery.getIntent(envelope.id)).toBeUndefined()
  expect((await readActionableEnvelopes(h.context, TARGET)).map((x) => x.envelope.id)).toContain(
    envelope.id
  )
})

it('keeps the envelope budget across store reopen and deduplicates a failed presentation', () => {
  const counter = h.store.launchFailures
  expect(counter.record('EN-restart', 'present-1', 'first')).toBe(1)
  expect(counter.record('EN-restart', 'present-1', 'first replay')).toBe(1)
  const reopened = openKickerStateStore(join(h.dir, 'hrc-mail-injector.sqlite'))
  try {
    expect(reopened.launchFailures.record('EN-restart', 'present-2', 'second')).toBe(2)
    expect(reopened.launchFailures.get('EN-restart')).toEqual({ attempts: 2, lastError: 'second' })
    expect(reopened.launchFailures.get('EN-other')).toBeUndefined()
  } finally {
    reopened.close?.()
  }
})

it('does not birth a fourth time if the third failure terminal RPC needs retry', async () => {
  const envelope = h.ledger.say()
  h.context.port.targetBySessionRef = async () => undefined
  let births = 0
  h.context.port.invoke = async () => {
    births++
    throw new Error('birth broke')
  }
  h.context.port.allRuntimes = async () => []
  const fail = h.context.ledger.fail.bind(h.context.ledger)
  h.context.ledger.fail = async () => {
    throw new Error('ledger unavailable')
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    h.context.mailKickerBirthSweepBackoff.clear()
    try {
      await driveMailTargetOnce(h.context, TARGET, 'periodic')
    } catch {}
  }
  h.context.ledger.fail = fail
  await driveMailTargetOnce(h.context, TARGET, 'periodic')
  expect(births).toBe(3)
  expect(h.ledger.envelopes.get(envelope.id)?.state).toBe('failed')
})

it('holds every delivery door during launch backoff, even when a failed runtime still reports live', async () => {
  const envelope = h.ledger.say()
  h.store.launchFailures.record(envelope.id, 'failed-launch', 'identity timeout')
  h.context.mailKickerBirthSweepBackoff.set(TARGET, { attempts: 1, nextAtMs: Date.now() + 60_000 })
  let probes = 0
  h.context.port.runtimesByHostSession = async () => {
    probes++
    throw new Error('must not probe or steer yet')
  }
  await driveMailTargetOnce(h.context, TARGET, 'periodic')
  expect(probes).toBe(0)
  expect(h.store.mailDelivery.getIntent(envelope.id)).toBeUndefined()
})
