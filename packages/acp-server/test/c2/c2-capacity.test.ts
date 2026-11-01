/**
 * T-12207 Work step 6: HRC's 256-per-subject quota refuses the receipt create,
 * which happens before any claim or send. That is a provable pre-dispatch
 * refusal: `not_submitted {reason: annotation_capacity}`, no send, no act, the
 * card untouched, and no receipt or other row pruned to make room.
 */
import { expect, test } from 'bun:test'

import {
  type ActionResponse,
  SEAT,
  replyRequest,
  seatSends,
  snapshotCard,
  withC2Acp,
} from './c2-acp.js'

test('annotation_quota at the receipt create is not_submitted annotation_capacity with nothing sent', async () => {
  await withC2Acp(async (acp) => {
    const { card } = await snapshotCard(acp)
    // Fill the card's generation subject to 256 rows (the card plus 255 notes).
    for (let i = 0; i < 255; i += 1) {
      acp.fake.put({ scopeRef: SEAT, generation: 2, kind: 'note', id: `n${i}`, body: { i } })
    }
    const before = structuredClone(acp.fake.annotations)
    const cardBefore = structuredClone(acp.card())
    const request = replyRequest(card)

    const response = await acp.post('/v1/mobile/c2/actions', request)
    expect([200, 503]).toContain(response.status)
    const body = (await response.json()) as ActionResponse
    expect(body.ok).toBe(false)
    expect(body.outcome).toBe('not_submitted')
    expect(body.reason).toBe('annotation_capacity')
    expect(body.requestId).toBe(request.requestId)

    expect(seatSends(acp)).toHaveLength(0)
    expect(
      acp.fake.ledger.filter((event) => event.eventKind === 'session.annotation.action')
    ).toHaveLength(0)
    expect(acp.fake.find(SEAT, 'receipt', request.requestId, 2)).toBeUndefined()
    expect(acp.card()).toEqual(cardBefore)
    expect(acp.fake.annotations).toEqual(before)
    expect(acp.fake.calls.some((call) => call.path === '/v1/sessions/annotations/delete')).toBe(
      false
    )
  })
})
