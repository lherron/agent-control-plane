import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { HrcDomainError, HrcErrorCode } from 'hrc-core'

import { deliverByColdBirth, deliverDigestToSeat } from '../drive/delivery.js'
import { readActionableEnvelopes } from '../drive/presentation.js'
import {
  TARGET_REF as TARGET,
  createT08094Harness,
  deliverOneTo,
  destroyT08094Harness,
  seatIn,
} from './t08094-harness.js'
import type { T08094Harness } from './t08094-harness.js'

let h: T08094Harness
beforeEach(async () => {
  h = await createT08094Harness()
})
afterEach(async () => {
  await destroyT08094Harness(h)
})

function refuse(error: Error) {
  h.context.port.steer = async () => {
    throw error
  }
  h.context.port.enqueue = async () => {
    throw error
  }
}

describe('T-10183 — definitive pre-admission delivery refusal', () => {
  for (const state of ['turn-active', 'booting'] as const) {
    it(`releases a ${state === 'booting' ? 'enqueue' : 'steer'} presentation-conflict intent without failing or receipting the envelope`, async () => {
      const envelope = h.ledger.say()
      refuse(
        new HrcDomainError(HrcErrorCode.PRESENTATION_CONFLICT, 'explicit operator conflicts', {})
      )
      expect(await deliverOneTo(h, seatIn(state), envelope)).toBe('refused')
      expect(h.db.mailDelivery.getIntent(envelope.id)).toBeUndefined()
      expect(h.ledger.envelopes.get(envelope.id)?.state).toBe('pending')
      expect(h.ledger.envelopes.get(envelope.id)?.presentedTo).toEqual([])
      expect(h.ledger.failRequests).toEqual([])
      expect(
        (await readActionableEnvelopes(h.context, TARGET)).map((item) => item.envelope.id)
      ).toContain(envelope.id)
      // Persistent refusal must not create an immediate self-wake loop.
      expect(h.wakes).toEqual([])
      // A later healthy drive submits exactly once; its admission fence then
      // prevents another pass from writing a second body before landing.
      h.context.port.steer = async () => h.dispatchResult()
      h.context.port.enqueue = async () => h.dispatchResult()
      expect(await deliverOneTo(h, seatIn(state), envelope)).toBe('submitted')
      expect(await readActionableEnvelopes(h.context, TARGET)).toEqual([])
    })
  }

  it('releases an invoke intent when a cold-birth race finds a conflicting live seat', async () => {
    const envelope = h.ledger.say()
    const [item] = await readActionableEnvelopes(h.context, TARGET)
    if (item === undefined) throw new Error('probe envelope must be actionable')
    h.context.port.invoke = async () => {
      throw new HrcDomainError(HrcErrorCode.PRESENTATION_CONFLICT, 'live runtime appeared', {})
    }
    await expect(deliverByColdBirth(h.context, TARGET, item, 'insert')).rejects.toThrow(
      'live runtime appeared'
    )
    expect(h.db.mailDelivery.getIntent(envelope.id)).toBeUndefined()
    expect(h.ledger.envelopes.get(envelope.id)?.state).toBe('pending')
  })

  it('releases every digest member on the same definitive refusal', async () => {
    const envelopes = [h.ledger.say({ obligation: 'fyi' }), h.ledger.say({ obligation: 'fyi' })]
    refuse(
      new HrcDomainError(HrcErrorCode.PRESENTATION_CONFLICT, 'explicit operator conflicts', {})
    )
    const items = envelopes.map((envelope) => ({ envelope, form: 'full' as const }))
    expect(
      await deliverDigestToSeat(
        h.context,
        TARGET,
        h.session,
        seatIn('turn-active'),
        items,
        'insert'
      )
    ).toEqual({ outcome: 'refused', members: 2 })
    for (const envelope of envelopes) {
      expect(h.db.mailDelivery.getIntent(envelope.id)).toBeUndefined()
      expect(h.ledger.envelopes.get(envelope.id)?.state).toBe('pending')
      expect(h.ledger.envelopes.get(envelope.id)?.presentedTo).toEqual([])
    }
    expect(
      (await readActionableEnvelopes(h.context, TARGET)).map((item) => item.envelope.id)
    ).toEqual(envelopes.map((envelope) => envelope.id))
  })

  for (const error of [
    new Error('socket closed after write'),
    new HrcDomainError(HrcErrorCode.RUNTIME_UNAVAILABLE, 'broker timed out', {}),
  ]) {
    it(`retains uncertainty for ${error.message} in single and digest delivery`, async () => {
      refuse(error)
      const single = h.ledger.say()
      await deliverOneTo(h, seatIn('turn-active'), single)
      const digest = h.ledger.say({ obligation: 'fyi' })
      await deliverDigestToSeat(
        h.context,
        TARGET,
        h.session,
        seatIn('turn-active'),
        [{ envelope: digest, form: 'full' }],
        'insert'
      )
      for (const envelope of [single, digest]) {
        expect(h.db.mailDelivery.getIntent(envelope.id)?.uncertainCause).toBe('dispatch_error')
      }
      expect(await readActionableEnvelopes(h.context, TARGET)).toEqual([])
    })
  }
})
