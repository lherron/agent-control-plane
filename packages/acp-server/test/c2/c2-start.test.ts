/**
 * Rev 5.1 §2.13 r3 (T-12645, card contract §6b) at the ACP host: an answer to a seat with no runtime resolves its
 * declaration, makes the exact claim-and-start keyed by requestId, reads the head for the generation, and then makes
 * the ordinary fenced literal input. The phone's feed carries `seat.online`.
 */
import { describe, expect, test } from 'bun:test'

import type { ActionResponse } from '@praesidium/c2-core'

import {
  ACTIONS,
  type C2Acp,
  SEAT,
  answerRequest,
  settle,
  snapshotEntry,
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
  acp.fake
    .literalInputs()
    .filter(
      (c) => (c.body as { selector?: { sessionRef?: string } }).selector?.sessionRef === SEAT_REF
    )
const startCalls = (acp: C2Acp) => acp.fake.calls.filter((c) => c.path === '/v1/runtimes/start')

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
  test('starts the seat once keyed by requestId, then sends fenced to the started host and generation', async () => {
    await withC2Acp(async (acp) => {
      const entry = await offlineEntry(acp)
      const req = answerRequest(entry)
      const { body } = await acp.postJson<ActionResponse>(ACTIONS, req)
      expect(body.outcome).toBe('sent')
      const starts = startCalls(acp)
      expect(starts.length).toBe(1)
      expect(starts[0]?.body).toMatchObject({
        sessionRef: SEAT_REF,
        conflictPolicy: 'reject',
        summonIntent: 'implicit',
        idempotencyKey: req.requestId,
        restartStyle: 'reuse_pty',
      })
      const decl = acp.fake.calls.find((c) => c.path === '/v1/declarations/resolve')
      expect(decl?.body).toMatchObject({
        scopeRef: SEAT,
        runMode: 'task',
        interactive: true,
        preferredMode: 'headless',
      })
      const seat = acp.fake.seats.get(SEAT)
      expect(seat?.hostSessionId).toBe('hsid-started-1')
      const inputs = seatInputs(acp)
      expect(inputs.length).toBe(1)
      expect(inputs[0]?.body).toMatchObject({
        text: req.text,
        fences: { expectedHostSessionId: 'hsid-started-1', expectedGeneration: seat?.generation },
      })
      const again = await acp.postJson<ActionResponse>(ACTIONS, req)
      expect(again.body.replayed).toBe(true)
      expect(startCalls(acp).length).toBe(1)
      expect(seatInputs(acp).length).toBe(1)
    })
  })

  test('a refused declaration or claim is start_failed, nothing sent', async () => {
    for (const set of [
      (a: C2Acp) => {
        a.fake.start.declarationRefuse = { status: 422, code: 'declaration_invalid' }
      },
      (a: C2Acp) => {
        a.fake.start.startRefuse = { status: 409, code: 'session_scope_occupied' }
      },
    ]) {
      await withC2Acp(async (acp) => {
        const entry = await offlineEntry(acp)
        set(acp)
        const { body } = await acp.postJson<ActionResponse>(ACTIONS, answerRequest(entry))
        expect(body).toMatchObject({ ok: false, outcome: 'not_submitted', reason: 'start_failed' })
        expect(seatInputs(acp).length).toBe(0)
      })
    }
  })

  test('a failed launch is unknown: nothing sent, and the question stays claimed', async () => {
    await withC2Acp(async (acp) => {
      const entry = await offlineEntry(acp)
      acp.fake.start.startRefuse = { status: 500, code: 'runtime_start_failed' }
      const { body } = await acp.postJson<ActionResponse>(ACTIONS, answerRequest(entry))
      expect(body.outcome).toBe('unknown_outcome')
      expect(seatInputs(acp).length).toBe(0)
      await settle(250)
      const claim = acp.fake.annotations.find(
        (row) => row.scopeRef === SEAT && row.kind === 'receipt' && row.id === 'answer:ship'
      )
      expect(claim).toBeDefined()
      const after = await snapshotEntry(acp)
      expect(after.entry.rows.find((r) => r.id === 'ship')?.state).not.toBe('open')
    })
  })

  test('an online seat never starts', async () => {
    await withC2Acp(async (acp) => {
      const { entry } = await snapshotEntry(acp)
      const { body } = await acp.postJson<ActionResponse>(ACTIONS, answerRequest(entry))
      expect(body.outcome).toBe('sent')
      expect(startCalls(acp).length).toBe(0)
    })
  })
})
