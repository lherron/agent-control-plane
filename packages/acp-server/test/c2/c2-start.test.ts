/**
 * Card contract rev 5.5 §6b (T-13491, c2-core 0.5.0) at the ACP host: an answer to a seat with no runtime is the
 * steer alone. HRC starts the seat on that steer, c2 puts its previous-session note in front, and the host makes
 * no start call of its own. The phone's feed carries `seat.online`.
 */
import { describe, expect, test } from 'bun:test'

import type { ActionResponse } from '@praesidium/c2-core'

import {
  ACTIONS,
  ANSWER_HEADER,
  type C2Acp,
  SEAT,
  answerRequest,
  settle,
  snapshotEntry,
  splitDeliveredAnswer,
  withC2Acp,
} from './c2-acp.js'

const SEAT_REF = `${SEAT}/lane:main`

/** Take the fixture seat's runtime away, as HRC's idle reap does. */
function reap(acp: C2Acp): void {
  const seat = acp.fake.seats.get(SEAT)
  if (seat === undefined) throw new Error('no fixture seat')
  seat.runtimeLive = false
  acp.fake.touch(SEAT, 'runtime.state')
}
const seatInputs = (acp: C2Acp) =>
  acp.fake.steers().filter((c) => (c.body as { target?: string }).target === SEAT_REF)
/** Any start the host makes itself: the keyed start and its declaration resolve. */
const startCalls = (acp: C2Acp) =>
  acp.fake.calls.filter(
    (c) => c.path === '/v1/runtimes/start' || c.path === '/v1/declarations/resolve'
  )

async function offlineEntry(acp: C2Acp) {
  // Read once while live so the record is observed, then reap and let observation see it.
  await snapshotEntry(acp)
  reap(acp)
  await settle(100)
  const { entry, snapshot } = await snapshotEntry(acp)
  expect(entry.seat.online).toBe(false)
  // The phone's feed carries it too.
  expect(
    (
      snapshot as unknown as { feed: Array<{ seat: { scopeRef: string; online: boolean } }> }
    ).feed.find((i) => i.seat.scopeRef === SEAT)?.seat.online
  ).toBe(false)
  return entry
}

describe('answering a seat with no runtime (§6b)', () => {
  test('sends one steer with the previous-session note and no start; the seat keeps its generation', async () => {
    await withC2Acp(async (acp) => {
      const entry = await offlineEntry(acp)
      const before = { ...acp.fake.seats.get(SEAT) }
      const req = answerRequest(entry)
      const { body } = await acp.postJson<ActionResponse>(ACTIONS, req)
      expect(body.outcome).toBe('sent')
      expect(startCalls(acp).length).toBe(0)
      const inputs = seatInputs(acp)
      expect(inputs.length).toBe(1)
      const sent = inputs[0]?.body as { body: string; idempotencyKey: string; origin: unknown }
      expect(sent.idempotencyKey).toBe(req.requestId)
      expect(sent.origin).toEqual({ principalRef: 'agent:lance' })
      // Rev 5.6 §6c with §6b: the header line, then the previous-session note, then a blank line and the text.
      const delivered = splitDeliveredAnswer(sent.body)
      expect(delivered.header).toMatch(ANSWER_HEADER)
      expect(delivered.rest.startsWith('You had no running session')).toBe(true)
      expect(delivered.rest.endsWith(`\n\n${req.text ?? ''}`)).toBe(true)
      const seat = acp.fake.seats.get(SEAT)
      expect(seat?.runtimeLive).toBe(true)
      expect(seat?.hostSessionId).toBe(before.hostSessionId)
      expect(seat?.generation).toBe(before.generation)
      const again = await acp.postJson<ActionResponse>(ACTIONS, req)
      expect(again.body.replayed).toBe(true)
      expect(seatInputs(acp).length).toBe(1)
    })
  })

  test('a steer refused before HRC starts anything is start_failed', async () => {
    for (const refuse of [
      { status: 422, code: 'cwd_missing' },
      { status: 503, code: 'runtime_unavailable', detail: { reason: 'aspd_unavailable' } },
    ]) {
      await withC2Acp(async (acp) => {
        const entry = await offlineEntry(acp)
        acp.fake.steerBorn.offlineRefuse = refuse
        const { body } = await acp.postJson<ActionResponse>(ACTIONS, answerRequest(entry))
        expect(body).toMatchObject({ ok: false, outcome: 'not_submitted', reason: 'start_failed' })
        expect(acp.fake.seats.get(SEAT)?.runtimeLive).toBe(false)
      })
    }
  })

  test('any other refusal is unknown, and the question stays claimed', async () => {
    await withC2Acp(async (acp) => {
      const entry = await offlineEntry(acp)
      acp.fake.steerBorn.offlineRefuse = { status: 500, code: 'internal_error' }
      const { body } = await acp.postJson<ActionResponse>(ACTIONS, answerRequest(entry))
      expect(body.outcome).toBe('unknown_outcome')
      await settle(250)
      const claim = acp.fake.annotations.find(
        (row) => row.scopeRef === SEAT && row.kind === 'receipt' && row.id === 'answer:ship'
      )
      expect(claim).toBeDefined()
      const after = await snapshotEntry(acp)
      expect(after.entry.rows.find((r) => r.id === 'ship')?.state).not.toBe('open')
    })
  })

  test('an online seat gets the answer with no note', async () => {
    await withC2Acp(async (acp) => {
      const { entry } = await snapshotEntry(acp)
      const req = answerRequest(entry)
      const { body } = await acp.postJson<ActionResponse>(ACTIONS, req)
      expect(body.outcome).toBe('sent')
      expect(startCalls(acp).length).toBe(0)
      const delivered = splitDeliveredAnswer((seatInputs(acp)[0]?.body as { body: string }).body)
      expect(delivered.header).toMatch(ANSWER_HEADER)
      expect(delivered.rest).toBe(req.text ?? '')
    })
  })
})
