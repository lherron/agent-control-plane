/**
 * Card contract rev 4 §3 quota: receipts, row claims, pings, details and the asks record share the seat
 * subject's 256-row quota. The receipt create happens before any claim or send, so its refusal is a provable
 * pre-dispatch refusal: `not_submitted {reason: annotation_capacity}`, no send, no act, the record untouched,
 * and no row pruned to make room.
 */
import { expect, test } from 'bun:test'

import {
  type ActionResponse,
  SEAT,
  answerRequest,
  seatSends,
  snapshotEntry,
  withC2Acp,
} from './c2-acp.js'

test('annotation_quota at the receipt create is not_submitted annotation_capacity with nothing sent', async () => {
  await withC2Acp(async (acp) => {
    const { entry } = await snapshotEntry(acp)
    // Fill the seat subject to 256 rows (the asks record and its detail plus 254 notes).
    for (let i = 0; i < 254; i += 1) {
      acp.fake.put({ scopeRef: SEAT, subject: 'seat', kind: 'note', id: `n${i}`, body: { i } })
    }
    const before = structuredClone(acp.fake.annotations)
    const recordBefore = structuredClone(acp.record())
    const request = answerRequest(entry)
    const response = await acp.post('/v1/mobile/c2/v2/actions', request)
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
    expect(acp.fake.find(SEAT, 'receipt', request.requestId, null)).toBeUndefined()
    expect(acp.record()).toEqual(recordBefore)
    expect(acp.fake.annotations).toEqual(before)
    expect(acp.fake.calls.some((call) => call.path === '/v1/sessions/annotations/delete')).toBe(
      false
    )
  })
})
