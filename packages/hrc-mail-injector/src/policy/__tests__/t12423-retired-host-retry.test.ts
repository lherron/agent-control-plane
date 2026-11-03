import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { HrcConflictError, HrcErrorCode } from 'hrc-core'
import type { HrcRuntimeIntent, HrcSessionRecord } from 'hrc-core'

import type { KickerDispatchOptions } from '../contracts.js'
import { driveMailTargetOnce } from '../drive/target-driver.js'
import type { T08094Harness } from './t08094-harness.js'
import {
  HOST_SESSION_ID,
  RUNTIME_ID,
  TARGET_REF,
  createT08094Harness,
  deliverOneTo,
  destroyT08094Harness,
  seatIn,
} from './t08094-harness.js'

/**
 * T-12423 — HRC T-12418 refuses a start on a host session that rotation
 * retired: 409 `stale_context`, reason `host_session_retired`, before any body
 * is admitted. The kicker must read that as not-written (no uncertainty fence),
 * must not charge it to the birth backoff, and the next ordinary drive must
 * re-resolve the target and land on the SUCCESSOR host, not loop on the
 * retired one.
 */

const SUCCESSOR = 'hsid-t12423-successor'

let h: T08094Harness
beforeEach(async () => {
  h = await createT08094Harness()
})
afterEach(async () => {
  await destroyT08094Harness(h)
})

function retiredHostRefusal(host: string): HrcConflictError {
  return new HrcConflictError(HrcErrorCode.STALE_CONTEXT, `host session ${host} is retired`, {
    expectedHostSessionId: host,
    activeHostSessionId: SUCCESSOR,
    sessionStatus: 'archived',
    reason: 'host_session_retired',
    retryable: true,
  })
}

/** Rotation: the retired host keeps a dead runtime, the successor is active. */
function rotate(): HrcSessionRecord {
  const now = new Date().toISOString()
  h.db.runtimes.update(RUNTIME_ID, { status: 'terminated', statusChangedAt: now, updatedAt: now })
  h.db.sessions.insert({
    hostSessionId: SUCCESSOR,
    scopeRef: h.session.scopeRef,
    laneRef: h.session.laneRef,
    generation: 2,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  })
  const successor = h.db.sessions.getByHostSessionId(SUCCESSOR)
  if (successor === null) throw new Error('successor session missing')
  return successor
}

describe('T-12423 — retry on stale_context/host_session_retired', () => {
  it('re-resolves the target and births on the successor host after a retired-host refusal', async () => {
    const successor = rotate()
    // HRC's own answer to "which host is active": the first drive resolved the
    // gen-1 host just before rotation retired it (the T-12418 TOCTOU); every
    // later resolution sees the successor.
    const staleOnce = () => {
      const pending: HrcSessionRecord[] = [h.session]
      return async () => pending.shift() ?? successor
    }
    h.context.port.targetBySessionRef = staleOnce()
    h.context.port.ensureTargetSession = staleOnce()
    const invokedOn: string[] = []
    h.context.port.invoke = async (
      session: HrcSessionRecord,
      _intent: HrcRuntimeIntent,
      _prompt: string,
      options: KickerDispatchOptions
    ) => {
      invokedOn.push(session.hostSessionId)
      if (session.hostSessionId !== SUCCESSOR) throw retiredHostRefusal(session.hostSessionId)
      h.dispatches.push({ ...options, submissionDoor: 'invoke' })
      return { ...h.dispatchResult(), hostSessionId: SUCCESSOR, generation: 2 }
    }

    const envelope = h.ledger.say()
    await driveMailTargetOnce(h.context, TARGET_REF, 'insert')

    // Not written: the fence is released, nothing uncertain, nothing failed,
    // no birth refusal or backoff charged, and no self-wake loop.
    expect(invokedOn).toEqual([HOST_SESSION_ID])
    expect(h.store.mailDelivery.getIntent(envelope.id)).toBeUndefined()
    expect(h.ledger.envelopes.get(envelope.id)?.state).toBe('pending')
    expect(h.ledger.failRequests).toEqual([])
    expect(h.store.launchFailures.get(envelope.id)).toBeUndefined()
    expect(h.context.mailKickerBirthSweepBackoff.has(TARGET_REF)).toBe(false)
    expect(h.wakes).toEqual([])
    expect(h.logs.map((log) => log.event)).toContain('wrkq.kicker.birth_host_retired')
    expect(h.logs.map((log) => log.event)).not.toContain('wrkq.kicker.birth_failed')
    expect(h.logs.find((log) => log.event === 'wrkq.kicker.delivery_failed')?.detail).toMatchObject(
      { envelope: envelope.id }
    )

    // The next ordinary drive lands on the successor, once.
    await driveMailTargetOnce(h.context, TARGET_REF, 'periodic')
    expect(invokedOn).toEqual([HOST_SESSION_ID, SUCCESSOR])
    expect(h.dispatches).toHaveLength(1)
    expect(h.store.mailDelivery.getIntent(envelope.id)).toMatchObject({
      door: 'invoke',
      hostSessionId: SUCCESSOR,
      generation: 2,
      submissionId: 'sub-1',
    })
  })

  for (const state of ['turn-active', 'booting'] as const) {
    it(`releases a ${state === 'booting' ? 'enqueue' : 'steer'} intent refused on a retired host as not written`, async () => {
      const refuse = async () => {
        throw retiredHostRefusal(HOST_SESSION_ID)
      }
      h.context.port.steer = refuse
      h.context.port.enqueue = refuse
      const envelope = h.ledger.say()
      expect(await deliverOneTo(h, seatIn(state), envelope)).toBe('refused')
      expect(h.store.mailDelivery.getIntent(envelope.id)).toBeUndefined()
      expect(h.ledger.envelopes.get(envelope.id)?.state).toBe('pending')
      expect(
        h.logs.find((log) => log.event === 'wrkq.kicker.delivery_failed')?.detail
      ).toMatchObject({ deliveryEvidence: 'not_written' })
    })
  }

  it('keeps an unrelated stale_context refusal uncertain', async () => {
    h.context.port.steer = async () => {
      throw new HrcConflictError(HrcErrorCode.STALE_CONTEXT, 'generation moved', {
        reason: 'generation_moved',
      })
    }
    const envelope = h.ledger.say()
    await deliverOneTo(h, seatIn('turn-active'), envelope)
    expect(h.store.mailDelivery.getIntent(envelope.id)?.uncertainCause).toBe('dispatch_error')
  })
})
