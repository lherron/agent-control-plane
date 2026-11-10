import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { HrcDomainError, HrcErrorCode } from 'hrc-core'

import { readActionableEnvelopes } from '../drive/presentation.js'
import { reconcileOpenIntents } from '../drive/reconcile.js'
import {
  RUNTIME_ID,
  type T08094Harness,
  TARGET_REF,
  createT08094Harness,
  deliverOneTo,
  destroyT08094Harness,
  seatIn,
} from './t08094-harness.js'

let h: T08094Harness
beforeEach(async () => {
  h = await createT08094Harness()
})
afterEach(async () => {
  await destroyT08094Harness(h)
})

describe('T-13155 runtime loss reconciliation', () => {
  for (const loss of ['unknown', 'terminated', 'absent'] as const) {
    it(`retires a terminal envelope once when its runtime is ${loss}`, async () => {
      const envelope = h.ledger.say()
      await deliverOneTo(h, seatIn('turn-active'), envelope)
      envelope.state = 'withdrawn'
      envelope.terminal = true
      h.context.port.runtime = async () => {
        if (loss === 'unknown') {
          throw new HrcDomainError(HrcErrorCode.UNKNOWN_RUNTIME, 'pruned', {
            runtimeId: RUNTIME_ID,
          })
        }
        const runtime = h.db.runtimes.getByRuntimeId(RUNTIME_ID)
        if (runtime === null) throw new Error('fixture runtime missing')
        return loss === 'absent' ? undefined : { ...runtime, status: 'terminated' }
      }

      expect(await reconcileOpenIntents(h.context, { reason: 'test' })).toMatchObject({
        runtime_gone: 1,
        open: 0,
      })
      expect(h.store.mailDelivery.getIntent(envelope.id)?.terminalEnvelopeAt).toBeDefined()
      expect(h.store.mailDelivery.listActiveOpenIntents()).toEqual([])
      expect(await reconcileOpenIntents(h.context, { reason: 'test' })).toMatchObject({
        runtime_gone: 0,
        open: 0,
      })
      expect(envelope.state).toBe('withdrawn')
      expect(h.ledger.presentRequests.filter((request) => !request.preview)).toEqual([])
      expect(h.ledger.failRequests).toEqual([])
      expect(h.dispatches).toHaveLength(1)
      expect(h.wakes).toEqual([])
      expect(h.logs.filter((log) => log.event === 'wrkq.kicker.intent_reconcile_failed')).toEqual(
        []
      )
    })
  }

  it('retains the no-second-write fence for a live envelope with an unknown runtime', async () => {
    const envelope = h.ledger.say()
    await deliverOneTo(h, seatIn('turn-active'), envelope)
    h.context.port.runtime = async () => {
      throw new HrcDomainError(HrcErrorCode.UNKNOWN_RUNTIME, 'pruned')
    }
    expect(await reconcileOpenIntents(h.context, { reason: 'test' })).toMatchObject({ open: 1 })
    expect(h.store.mailDelivery.getIntent(envelope.id)?.uncertainCause).toBe(
      'runtime_terminated_before_landing'
    )
    expect(h.store.mailDelivery.getIntent(envelope.id)?.terminalEnvelopeAt).toBeUndefined()
    expect(await readActionableEnvelopes(h.context, TARGET_REF)).toEqual([])
    expect(h.dispatches).toHaveLength(1)
    expect(h.wakes).toEqual([])
    expect(h.ledger.failRequests).toEqual([])
  })

  for (const error of [
    new HrcDomainError(HrcErrorCode.RUNTIME_UNAVAILABLE, 'unknown runtime'),
    new Error('unknown runtime'),
  ]) {
    it(`keeps other read errors open and retries: ${error.name}`, async () => {
      const envelope = h.ledger.say()
      await deliverOneTo(h, seatIn('turn-active'), envelope)
      envelope.state = 'withdrawn'
      envelope.terminal = true
      let reads = 0
      h.context.port.runtime = async () => {
        reads += 1
        throw error
      }
      for (let pass = 0; pass < 2; pass += 1) {
        expect(await reconcileOpenIntents(h.context, { reason: 'periodic' })).toMatchObject({
          runtime_gone: 0,
          open: 1,
        })
      }
      expect(reads).toBe(2)
      expect(h.store.mailDelivery.listActiveOpenIntents()).toHaveLength(1)
      expect(h.store.mailDelivery.getIntent(envelope.id)?.uncertainCause).toBeUndefined()
      expect(h.dispatches).toHaveLength(1)
      expect(h.wakes).toEqual([])
      expect(h.ledger.failRequests).toEqual([])
    })
  }
})
