/**
 * Card contract rev 5.2 (T-13271, docs/proposals/answers-steer.md r1.2): a phone answer is HRC's steer.
 * The fake's replies are shaped from max3 HRC's (T-13271 artifacts sdk-steer-*.json, probe-steer-self.json).
 * A downgrade is delivered with its door report; an explicit rejection is not_submitted with the claims
 * released; a cursorless lost reply may have been applied, so it is unknown with the claims held.
 * Every non-answer line (here, the acted line to Vesta) stays fenced literal input.
 */
import { describe, expect, test } from 'bun:test'

import {
  ACTIONS,
  type ActionResponse,
  SEAT,
  VESTA,
  answerRequest,
  seatSends,
  settle,
  snapshotEntry,
  withC2Acp,
} from './c2-acp.js'

describe('rev 5.2: phone answers steer', () => {
  test('a downgraded steer is delivered and its door report rides on the receipt', async () => {
    await withC2Acp(async (acp) => {
      acp.fake.steer.mode = 'downgrade'
      const { entry } = await snapshotEntry(acp)
      const { body } = await acp.postJson<ActionResponse>(ACTIONS, answerRequest(entry))
      expect(body.outcome).toBe('sent')
      expect(body.receipt).toMatchObject({
        sessionRef: `${SEAT}/lane:main`,
        runId: expect.any(String),
        door: { effective: 'enqueue', downgradeReason: 'steer_not_supported' },
      })
      expect(acp.fake.find(SEAT, 'receipt', 'answer:ship', null)?.body).toMatchObject({
        outcome: 'delivered',
      })
    })
  })

  test('an ordinary steer reports door steer', async () => {
    await withC2Acp(async (acp) => {
      const { entry } = await snapshotEntry(acp)
      const { body } = await acp.postJson<ActionResponse>(ACTIONS, answerRequest(entry))
      expect(body.outcome).toBe('sent')
      expect(body.receipt?.door).toEqual({ effective: 'steer' })
      await settle()
      const toVesta = acp.fake
        .literalInputs()
        .filter(
          (c) =>
            (c.body as { selector?: { sessionRef?: string } }).selector?.sessionRef ===
            `${VESTA}/lane:main`
        )
      expect(toVesta).toHaveLength(1)
      expect(toVesta[0]?.body).toMatchObject({
        enter: true,
        fences: { expectedGeneration: expect.any(Number) },
      })
    })
  })

  test('an explicitly rejected steer is not_submitted with its reason; the row is answerable again', async () => {
    await withC2Acp(async (acp) => {
      acp.fake.steer.mode = 'reject'
      const { entry } = await snapshotEntry(acp)
      const { body } = await acp.postJson<ActionResponse>(ACTIONS, answerRequest(entry))
      expect(body).toMatchObject({ ok: false, outcome: 'not_submitted', reason: 'guarded' })
      expect(acp.fake.find(SEAT, 'receipt', 'answer:ship', null)).toBeUndefined()
      acp.fake.steer.mode = 'accept'
      const { entry: again } = await snapshotEntry(acp)
      expect((await acp.postJson<ActionResponse>(ACTIONS, answerRequest(again))).body.outcome).toBe(
        'sent'
      )
      expect(seatSends(acp)).toHaveLength(2)
    })
  })

  test('a cursorless lost steer is unknown: claims held, no resend (Daedalus F1, EN-50789)', async () => {
    await withC2Acp(async (acp) => {
      acp.fake.steer.mode = 'lost'
      const { entry } = await snapshotEntry(acp)
      const { body } = await acp.postJson<ActionResponse>(ACTIONS, answerRequest(entry))
      expect(body.outcome).toBe('unknown_outcome')
      expect(acp.fake.find(SEAT, 'receipt', 'answer:ship', null)?.body).toMatchObject({
        rowId: 'ship',
      })
      await settle(300)
      expect(seatSends(acp)).toHaveLength(1)
    })
  })
})
