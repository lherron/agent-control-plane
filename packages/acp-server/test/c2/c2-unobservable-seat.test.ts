/**
 * A seat this node cannot observe must not take C2 down (T-12207, EN-40184).
 * On max3, `agent:stella:project:arris:task:primary-quasar` answers its
 * annotation list with HRC `session_home_pending` (503: the node retired the
 * scope and no home is bound yet). One such seat failed the production
 * sweep and every snapshot. A per-seat HRC refusal now skips that seat for the
 * pass, logged once per seat and code; an action on its card still refuses
 * through normal preflight; Vesta and HRC itself stay strict.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  type ActionResponse,
  RETIRED_SEAT,
  SEAT,
  type Snapshot,
  VESTA,
  reconcilePath,
  replyRequest,
  seatSends,
  settle,
  snapshotCard,
  withC2Acp,
} from './c2-acp.js'

const NOT_HERE = [
  'session_home_pending',
  'session_home_unknown',
  'session_home_unreachable',
  'session_home_malformed',
]

let logged: string[] = []
const original = console.log
beforeEach(() => {
  logged = []
  console.log = (...args: unknown[]) => {
    logged.push(args.map(String).join(' '))
    original(...args)
  }
})
afterEach(() => {
  console.log = original
})

describe('an unobservable seat', () => {
  for (const code of NOT_HERE) {
    for (const route of ['annotations', 'attention'] as const) {
      test(`${code} on ${route} skips the seat; the snapshot still answers`, async () => {
        await withC2Acp(
          async (acp) => {
            const { status, body } = await acp.getJson<Snapshot>('/v1/mobile/c2/cards')
            expect(status).toBe(200)
            expect(body.home).toMatchObject({ reachable: true, stale: false })
            expect(body.seats.map((seat) => seat.scopeRef)).toEqual([SEAT])
            if (route === 'attention') {
              const asked = acp.fake.calls.filter(
                (call) =>
                  call.path === '/v1/sessions/attention' && call.query['scopeRef'] === RETIRED_SEAT
              )
              expect(asked.length).toBeGreaterThan(0)
            }
          },
          {
            beforeBoot: (fake) => {
              // A card makes the seat one the production instance observes.
              if (route === 'attention') {
                fake.put({
                  scopeRef: RETIRED_SEAT,
                  generation: 1,
                  kind: 'card',
                  id: 'a1',
                  body: { v: 4, state: 'open' },
                })
              }
              fake.seatErrors.set(RETIRED_SEAT, { status: 503, code, routes: [route] })
            },
          }
        )
      })
    }
  }

  test('the skip is logged once per seat and code, not every pass', async () => {
    await withC2Acp(
      async (acp) => {
        for (let i = 0; i < 3; i += 1) await acp.getJson('/v1/mobile/c2/cards')
        await settle(300)
        const lines = logged.filter(
          (line) => line.includes('c2.seat.unobservable') && line.includes(RETIRED_SEAT)
        )
        expect(lines).toHaveLength(1)
        expect(lines[0]).toContain('session_home_pending')
      },
      {
        beforeBoot: (fake) =>
          fake.seatErrors.set(RETIRED_SEAT, {
            status: 503,
            code: 'session_home_pending',
            routes: ['annotations'],
          }),
      }
    )
  })

  /** Nothing reported delivery, and no call could birth, resolve or bind a home. */
  function expectNothingDelivered(
    acp: Parameters<Parameters<typeof withC2Acp>[0]>[0],
    requestId: string
  ) {
    expect(seatSends(acp)).toHaveLength(0)
    expect(acp.fake.find(SEAT, 'receipt', requestId, 2)?.body['stage'] ?? 'absent').not.toMatch(
      /dispatching|delivered/
    )
    const okActs = acp.fake.ledger.filter(
      (event) =>
        event.eventKind === 'session.annotation.action' &&
        (event.payload['attributes'] as { ok?: boolean }).ok === true
    )
    expect(okActs).toHaveLength(0)
    const allowed =
      /^\/v1\/(sessions(\/attention|\/annotations(\/act|\/delete)?)?|literal-input\/by-selector|status)$/
    expect(
      acp.fake.calls.filter((call) => !allowed.test(call.path)).map((call) => call.path)
    ).toEqual([])
  }

  test('a retired scope (reads and writes refused) answers typed not_submitted session_home_pending', async () => {
    await withC2Acp(async (acp) => {
      const { card } = await snapshotCard(acp)
      acp.fake.seatErrors.set(SEAT, {
        status: 503,
        code: 'session_home_pending',
        routes: ['annotations', 'attention'],
      })
      await settle(200)
      const request = replyRequest(card)
      const { status, body } = await acp.postJson<ActionResponse>('/v1/mobile/c2/actions', request)
      // c2-core's first step, the create-only receipt, is refused: provably pre-dispatch.
      expect(status).toBe(503)
      expect(body).toMatchObject({
        ok: false,
        outcome: 'not_submitted',
        reason: 'session_home_pending',
        replayed: false,
      })
      expectNothingDelivered(acp, request.requestId)
      // Healthy seats and the scope row keep working: Vesta still reads, the seat is just absent.
      const { status: snapStatus, body: snapshot } =
        await acp.getJson<Snapshot>('/v1/mobile/c2/cards')
      expect(snapStatus).toBe(200)
      expect(snapshot.vesta.online).toBe(true)
      expect(snapshot.seats.some((seat) => seat.scopeRef === SEAT)).toBe(false)
    })
  })

  test('an unreadable live row keeps the card visible and refuses with c2-core preflight seat_unknown', async () => {
    await withC2Acp(async (acp) => {
      const { card } = await snapshotCard(acp)
      acp.fake.seatErrors.set(SEAT, {
        status: 503,
        code: 'session_home_unreachable',
        routes: ['attention'],
      })
      await settle(200)
      const { body: snapshot } = await acp.getJson<Snapshot>('/v1/mobile/c2/cards')
      const shown = snapshot.seats.find((seat) => seat.scopeRef === SEAT)?.card
      // The card is still there, unknown rather than moved: never superseded on a missing row.
      expect(shown?.key).toEqual(card.key)
      expect(shown?.state).toBe('open')
      expect(shown?.seat.online).toBe(false)
      const request = replyRequest(card)
      const { status, body } = await acp.postJson<ActionResponse>('/v1/mobile/c2/actions', request)
      expect(status).toBe(503)
      expect(body).toMatchObject({
        ok: false,
        outcome: 'not_submitted',
        reason: 'seat_unknown',
        replayed: false,
      })
      expect(acp.fake.find(SEAT, 'receipt', request.requestId, 2)?.body['stage']).toBe('done')
      expectNothingDelivered(acp, request.requestId)
      const readback = await acp.getJson<ActionResponse>(
        reconcilePath(request.requestId, request.key)
      )
      expect(readback.body).toMatchObject({ outcome: 'not_submitted', reason: 'seat_unknown' })
    })
  })

  test('Vesta stays strict: her unreadable rows make the snapshot unavailable, never empty', async () => {
    await withC2Acp(
      async (acp) => {
        const { status, body } = await acp.getJson('/v1/mobile/c2/cards')
        expect(status).toBe(503)
        expect(body).toEqual({ ok: false, code: 'home_unavailable' })
      },
      {
        beforeBoot: (fake) =>
          fake.seatErrors.set(VESTA, {
            status: 503,
            code: 'session_home_pending',
            routes: ['annotations'],
          }),
      }
    )
  })
})
