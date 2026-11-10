/**
 * An HRC steer (rev 5.2; before it, literal input) that is accepted on the local socket and never answered (card contract rev 4 §6
 * step 7). After the call was made the outcome is indeterminate: `unknown_outcome`, exactly one attempt, the
 * receipt left at `sending` and the row claim held, so the row reads in flight. Never `not_submitted`, never
 * retried; recovery later records it `done {unknown_outcome}` with the claim's outcome `unknown`.
 */
import { expect, test } from 'bun:test'

import {
  ACTIONS,
  type ActionResponse,
  SEAT,
  SEAT_REF,
  answerRequest,
  reconcilePath,
  seatSends,
  settle,
  snapshotEntry,
  withC2Acp,
} from './c2-acp.js'

test('a steer timeout is unknown_outcome with one attempt, receipt sending and the row claim held', async () => {
  await withC2Acp(
    async (acp) => {
      const { entry } = await snapshotEntry(acp)
      acp.fake.steer.mode = 'hang'
      const request = answerRequest(entry)
      const started = Date.now()
      const { status, body } = await acp.postJson<ActionResponse>(ACTIONS, request)
      expect(Date.now() - started).toBeLessThan(5000)
      expect(status).toBe(200)
      expect(body).toMatchObject({
        ok: false,
        outcome: 'unknown_outcome',
        requestId: request.requestId,
      })
      expect(seatSends(acp)).toHaveLength(1)

      await settle(1000)
      expect(seatSends(acp)).toHaveLength(1)
      expect(acp.fake.find(SEAT, 'receipt', request.requestId, null)?.body['stage']).toBe('sending')
      expect(acp.fake.find(SEAT, 'receipt', 'answer:ship', null)?.body).toMatchObject({
        requestId: request.requestId,
      })
      expect(
        acp.fake.ledger.filter((e) => e.eventKind === 'session.annotation.action')
      ).toHaveLength(0)

      const replay = await acp.postJson<ActionResponse>(ACTIONS, request)
      expect(replay.body).toMatchObject({ outcome: 'unknown_outcome', replayed: true })
      expect(
        (await acp.getJson<ActionResponse>(reconcilePath(request.requestId, SEAT_REF))).body.outcome
      ).toBe('unknown_outcome')

      const { entry: now } = await snapshotEntry(acp)
      expect(now.rows[0]?.state).toBe('in_flight')
      const fresh = await acp.postJson<ActionResponse>(ACTIONS, answerRequest(now))
      expect(fresh.body.outcome).toBe('invalid_action') // no open row to answer
      expect(seatSends(acp)).toHaveLength(1)
    },
    { config: { literalInputTimeoutMs: 250, pollMs: 50 } }
  )
})

test('past the grace, recovery records unknown_outcome and the row becomes uncertain with release', async () => {
  await withC2Acp(
    async (acp) => {
      const { entry } = await snapshotEntry(acp)
      acp.fake.steer.mode = 'hang'
      const request = answerRequest(entry)
      await acp.postJson<ActionResponse>(ACTIONS, request)
      await settle(600)
      // Any observable HRC change ticks the controller now instead of in 15 s.
      acp.fake.put({ scopeRef: SEAT, subject: 'seat', kind: 'note', id: 'nudge', body: {} })
      await settle(600)
      expect(acp.fake.find(SEAT, 'receipt', request.requestId, null)?.body).toMatchObject({
        stage: 'done',
        result: { outcome: 'unknown_outcome' },
      })
      const { entry: now } = await snapshotEntry(acp)
      expect(now.rows[0]?.state).toBe('uncertain')
      expect(now.rows[0]?.actions.map((a) => a.kind)).toEqual(['release'])
      expect(seatSends(acp)).toHaveLength(1)
    },
    { config: { literalInputTimeoutMs: 250, pollMs: 50, graceMs: 300 } }
  )
})
