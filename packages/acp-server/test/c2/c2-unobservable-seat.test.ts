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

  test('an action on an unobservable seat is refused before dispatch and sends nothing', async () => {
    await withC2Acp(async (acp) => {
      const { card } = await snapshotCard(acp)
      // HRC refuses reads and writes alike for a scope it retired.
      acp.fake.seatErrors.set(SEAT, {
        status: 503,
        code: 'session_home_pending',
        routes: ['annotations', 'attention'],
      })
      await settle(200)
      const { status, body } = await acp.postJson<ActionResponse>(
        '/v1/mobile/c2/actions',
        replyRequest(card)
      )
      // c2-core's first step, the create-only receipt, is refused: provably pre-dispatch.
      expect(status).toBe(503)
      expect(body).toMatchObject({
        ok: false,
        outcome: 'not_submitted',
        reason: 'session_home_pending',
      })
      expect(seatSends(acp)).toHaveLength(0)
      // The seat no longer projects; nothing else is affected.
      const { status: snapStatus, body: snapshot } =
        await acp.getJson<Snapshot>('/v1/mobile/c2/cards')
      expect(snapStatus).toBe(200)
      expect(snapshot.seats.some((seat) => seat.scopeRef === SEAT)).toBe(false)
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
