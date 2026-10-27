import { afterEach, beforeEach, describe, expect, it, setSystemTime } from 'bun:test'

import type { KickerDispatchOptions } from '../contracts.js'
import { deliverFailureNotices } from '../terminal/failure-notices.js'
import {
  type T08094Harness,
  TARGET_REF,
  createT08094Harness,
  destroyT08094Harness,
} from './t08094-harness.js'

describe('sender failure notice dispatch uncertainty', () => {
  let h: T08094Harness

  beforeEach(async () => {
    h = await createT08094Harness()
  })

  afterEach(async () => {
    setSystemTime()
    await destroyT08094Harness(h)
  })

  it('replays one stable HRC dispatch after a lost response instead of writing the notice again', async () => {
    presentOn('rt-t08094')
    h.store.mailDelivery.recordFailureNotice({
      envelopeId: 'EN-15268',
      targetSessionRef: TARGET_REF,
      notice: 'retired sender failure',
    })
    h.store.mailDelivery.recordFailureNotice({
      envelopeId: 'EN-15281',
      targetSessionRef: TARGET_REF,
      notice: 'retired recovery failure',
    })

    const attempts: KickerDispatchOptions[] = []
    h.context.port.enqueue = async (_session, _intent, _prompt, options) => {
      attempts.push(options)
      if (attempts.length === 1) throw new Error('dispatch response timed out after acceptance')
      return h.dispatchResult()
    }

    await deliverFailureNotices(h.context, TARGET_REF, h.session)
    expect(h.store.mailDelivery.listUndeliveredFailureNotices(TARGET_REF)).toHaveLength(2)

    await deliverFailureNotices(h.context, TARGET_REF, h.session)
    expect(attempts).toHaveLength(2)
    expect(attempts[0]?.idempotencyKey).toMatch(/^hrc-mail-failure-notice-[0-9a-f]{64}$/)
    expect(attempts[1]?.idempotencyKey).toBe(attempts[0]?.idempotencyKey)
    expect(h.store.mailDelivery.listUndeliveredFailureNotices(TARGET_REF)).toHaveLength(0)

    await deliverFailureNotices(h.context, TARGET_REF, h.session)
    expect(attempts).toHaveLength(2)
  })

  // foundry-acceptance-{host,k10,lifecycle}, 2026-10-04: three senders
  // whose seats could not take a notice drove one HRC submission every sweep,
  // indefinitely — about 80% of live admission traffic.
  // A notice only rides a live broker seat (T-11970), so present one.
  function presentOn(runtimeId: string): void {
    h.context.port.runtimesByHostSession = async () =>
      [
        {
          runtimeId,
          generation: h.session.generation,
          status: 'ready',
          controllerKind: 'harness-broker',
          activeInvocationId: `inv-${runtimeId}`,
        },
      ] as never
    h.context.port.seat = async () =>
      ({
        runtimeId,
        invocationId: `inv-${runtimeId}`,
        generation: h.session.generation,
        admissionClasses: ['enqueue'],
        currentBrokerSeq: 0,
        probe: { seat: { state: 'idle' } },
        probeError: null,
      }) as never
  }

  it('parks a notice whose stable dispatch replays a failed start until the sender reseats', async () => {
    h.store.mailDelivery.recordFailureNotice({
      envelopeId: 'EN-19187',
      targetSessionRef: TARGET_REF,
      notice: 'assessment to lance failed',
    })
    presentOn('rt-stuck')
    const attempts: KickerDispatchOptions[] = []
    h.context.port.enqueue = async (_session, _intent, _prompt, options) => {
      attempts.push(options)
      return { ...h.dispatchResult(), status: 'failed', replayed: attempts.length > 1 }
    }

    for (let sweep = 0; sweep < 5; sweep += 1) {
      await deliverFailureNotices(h.context, TARGET_REF, h.session)
    }
    expect(attempts).toHaveLength(1)
    expect(h.store.mailDelivery.listUndeliveredFailureNotices(TARGET_REF)).toHaveLength(1)

    // A newly owed notice is a different dispatch, so it gets one try of its own.
    h.store.mailDelivery.recordFailureNotice({
      envelopeId: 'EN-19372',
      targetSessionRef: TARGET_REF,
      notice: 'second assessment to lance failed',
    })
    await deliverFailureNotices(h.context, TARGET_REF, h.session)
    await deliverFailureNotices(h.context, TARGET_REF, h.session)
    expect(attempts).toHaveLength(2)

    presentOn('rt-reseated')
    h.context.port.enqueue = async (_session, _intent, _prompt, options) => {
      attempts.push(options)
      return h.dispatchResult()
    }
    await deliverFailureNotices(h.context, TARGET_REF, h.session)
    expect(attempts).toHaveLength(3)
    expect(attempts[2]?.idempotencyKey).not.toBe(attempts[1]?.idempotencyKey)
    expect(h.store.mailDelivery.listUndeliveredFailureNotices(TARGET_REF)).toHaveLength(0)
  })

  it('backs off a sender whose seat keeps refusing the notice', async () => {
    h.store.mailDelivery.recordFailureNotice({
      envelopeId: 'EN-19188',
      targetSessionRef: TARGET_REF,
      notice: 'assessment to lance failed',
    })
    presentOn('rt-detached')
    let attempts = 0
    h.context.port.enqueue = async () => {
      attempts += 1
      throw new Error(
        'participant attempt pa-1 is DETACHED with an exhausted reconnect budget after 5 attempt(s)'
      )
    }

    for (let sweep = 0; sweep < 10; sweep += 1) {
      await deliverFailureNotices(h.context, TARGET_REF, h.session)
    }
    // One immediate replay covers a lost dispatch response; after that the
    // refusal waits out a backoff instead of costing a submission per sweep.
    expect(attempts).toBe(2)
    expect(h.store.mailDelivery.listUndeliveredFailureNotices(TARGET_REF)).toHaveLength(1)

    // A reattached seat does not reset the backoff (T-11970): the notice
    // waits out the current delay, then rides the new seat.
    presentOn('rt-reattached')
    h.context.port.enqueue = async () => {
      attempts += 1
      return h.dispatchResult()
    }
    await deliverFailureNotices(h.context, TARGET_REF, h.session)
    expect(attempts).toBe(2)
    setSystemTime(new Date(Date.now() + 60 * 60_000))
    await deliverFailureNotices(h.context, TARGET_REF, h.session)
    expect(attempts).toBe(3)
    expect(h.store.mailDelivery.listUndeliveredFailureNotices(TARGET_REF)).toHaveLength(0)
  })
})
