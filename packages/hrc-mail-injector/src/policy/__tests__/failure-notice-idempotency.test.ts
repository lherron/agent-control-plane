import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

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
    await destroyT08094Harness(h)
  })

  it('replays one stable HRC dispatch after a lost response instead of writing the notice again', async () => {
    h.db.mailDelivery.recordFailureNotice({
      envelopeId: 'EN-15268',
      targetSessionRef: TARGET_REF,
      notice: 'retired sender failure',
    })
    h.db.mailDelivery.recordFailureNotice({
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
    expect(h.db.mailDelivery.listUndeliveredFailureNotices(TARGET_REF)).toHaveLength(2)

    await deliverFailureNotices(h.context, TARGET_REF, h.session)
    expect(attempts).toHaveLength(2)
    expect(attempts[0]?.idempotencyKey).toMatch(/^hrc-mail-failure-notice-[0-9a-f]{64}$/)
    expect(attempts[1]?.idempotencyKey).toBe(attempts[0]?.idempotencyKey)
    expect(h.db.mailDelivery.listUndeliveredFailureNotices(TARGET_REF)).toHaveLength(0)

    await deliverFailureNotices(h.context, TARGET_REF, h.session)
    expect(attempts).toHaveLength(2)
  })
})
