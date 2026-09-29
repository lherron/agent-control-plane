import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type { WrkqEnvelopeObligation } from '../ledger/types.js'
import { queueFailureNotice } from '../terminal/failure-notices.js'
import {
  SCOPE_REF,
  type T08094Harness,
  TARGET_REF,
  createT08094Harness,
  destroyT08094Harness,
} from './t08094-harness.js'

// T-09880: a failed envelope earns its sender a "Resend or escalate" notice
// only when something was owed on it. A fyi (and its successor class, notify)
// carries no obligation, and undeliverable-to-an-ended-seat is its designed
// outcome — the same rule Lance ruled for the inbox listing.
describe('sender failure notice by obligation', () => {
  let h: T08094Harness

  beforeEach(async () => {
    h = await createT08094Harness()
  })

  afterEach(async () => {
    await destroyT08094Harness(h)
  })

  async function failAs(obligation: WrkqEnvelopeObligation) {
    const envelope = h.ledger.say({
      obligation,
      from: { principalRef: 'agent:clod', scopeRef: SCOPE_REF },
    })
    await queueFailureNotice(h.context, {
      resourceId: envelope.id,
      payload: JSON.stringify({
        state: 'failed',
        reason: 'undeliverable',
        detail: 'envelope_ttl_expired',
      }),
    } as never)
    return envelope
  }

  it('queues no notice for a failed fyi or notify', async () => {
    await failAs('fyi')
    await failAs('notify')
    expect(h.db.mailDelivery.listUndeliveredFailureNotices(TARGET_REF)).toHaveLength(0)
    expect(h.wakes).toHaveLength(0)
  })

  it('still queues the notice for a failed reply_required', async () => {
    const envelope = await failAs('reply_required')
    const queued = h.db.mailDelivery.listUndeliveredFailureNotices(TARGET_REF)
    expect(queued).toHaveLength(1)
    expect(queued[0]?.envelopeId).toBe(envelope.id)
    expect(queued[0]?.notice).toContain('Resend or escalate')
    expect(h.wakes).toEqual([TARGET_REF])
  })
})
