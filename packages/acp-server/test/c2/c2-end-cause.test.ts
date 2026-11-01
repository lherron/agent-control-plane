/**
 * T-12233 through ACP: c2-core 0.1.7 end causes over the real HRC wire. ACP's
 * C2Host answers `runtimeEnd` from the HRC runtime record of the card's host
 * session (`GET /v1/runtimes?hostSessionId=…&all=true`,
 * `runtimeStateJson.terminationReason`) and `handoffSince` from its wrkq
 * client (`wrkq.handoff.listView`, status all). A quit at the prompt holds the
 * card until HRC records the termination, then ends it `runtime_ended`, writes
 * the `ended` ledger action and sends Vesta exactly one `[c2] rotated …` line.
 */
import { describe, expect, test } from 'bun:test'

import type { WorkClient } from '@wrkq/client'

import { ATTENTION_AT, type C2Acp, SEAT, VESTA, settle, withC2Acp } from './c2-acp.js'

const CARD_ID = `${SEAT}#2#${ATTENTION_AT}`
const VESTA_REF = `${VESTA}/lane:main`
const LINE = `[c2] rotated ${SEAT} gen 2→none reason=user_initiated_session_end prior=rt-c2fixture-acp card=${CARD_ID}`

const rotatedLines = (acp: C2Acp) =>
  acp.fake
    .literalInputs()
    .map((call) => call.body as { selector?: { sessionRef?: string }; text?: string })
    .filter((b) => b.selector?.sessionRef === VESTA_REF && b.text?.startsWith('[c2] rotated'))
    .map((b) => b.text)

/** HRC as a /quit leaves it: the termination recorded, the runtime not live, attention gone. */
function quit(acp: C2Acp, record = true): void {
  if (record) {
    acp.fake.runtimes.push({
      runtimeId: 'rt-c2fixture-acp',
      hostSessionId: 'hsid-c2fixture-acp',
      scopeRef: SEAT,
      laneRef: 'main',
      generation: 2,
      status: 'terminated',
      statusChangedAt: '2026-11-01T05:30:00.000Z',
      runtimeStateJson: {
        terminationReason: 'user_initiated_session_end',
        userExitReason: 'prompt_input_exit',
      },
      createdAt: '2026-11-01T04:00:00.000Z',
      updatedAt: '2026-11-01T05:30:00.000Z',
    })
  }
  const seat = acp.fake.seats.get(SEAT)!
  seat.runtimeLive = false
}

/** Any observable HRC change, so the controller ticks now instead of in 15 s. */
function nudge(acp: C2Acp, n: number): void {
  acp.fake.put({
    scopeRef: 'agent:mable:project:human:task:primary',
    generation: 4,
    kind: 'card',
    id: `2026-11-01T04:0${n}:00.000Z`,
    body: {
      v: 4,
      source: 'vesta',
      state: 'resolved',
      endedAt: '2026-11-01T04:00:00.000Z',
      title: 'nudge',
      actions: [],
    },
  })
}

function fakeWorkClient(createdAt: string | null, calls: unknown[]): WorkClient {
  return {
    wrkq: {
      handoff: {
        listView: async (params: unknown) => {
          calls.push(params)
          return {
            items:
              createdAt === null ? [] : [{ id: 'H-1', status: 'pending', created_at: createdAt }],
          }
        },
      },
    },
  } as unknown as WorkClient
}

describe('card end causes over ACP (T-12233)', () => {
  test('a quit at the prompt is held until HRC records it, then runtime_ended with one rotated line', async () => {
    await withC2Acp(
      async (acp) => {
        await settle()
        quit(acp, false)
        await settle()
        expect(acp.card().body['state']).toBe('open') // held: not live, termination unconfirmed
        expect(rotatedLines(acp)).toEqual([])

        quit(acp)
        nudge(acp, 1)
        await settle()
        const body = acp.card().body as Record<string, any>
        expect(body['state']).toBe('superseded')
        expect(body['endCause']).toMatchObject({
          kind: 'runtime_ended',
          generation: 2,
          priorRuntimeId: 'rt-c2fixture-acp',
          terminatedReason: 'user_initiated_session_end',
        })
        expect(typeof body['endCause'].wake.sentAt).toBe('string')
        expect(rotatedLines(acp)).toEqual([`${LINE} handoff=unknown`])
        const ended = acp.fake.ledger.filter(
          (e) =>
            e.eventKind === 'session.annotation.action' &&
            e.payload['action'] === 'ended' &&
            e.scopeRef === SEAT
        )
        const { wake: _wake, ...cause } = body['endCause']
        expect(ended.map((e) => e.payload['attributes'])).toEqual([
          { state: 'superseded', endCause: cause },
        ])
        expect(
          acp.fake.calls.some(
            (c) =>
              c.path === '/v1/runtimes' &&
              c.query['hostSessionId'] === 'hsid-c2fixture-acp' &&
              c.query['all'] === 'true'
          )
        ).toBe(true)

        // the relaunch sends nothing more
        const seat = acp.fake.seats.get(SEAT)!
        seat.generation = 3
        seat.hostSessionId = 'hsid-c2fixture-acp-3'
        seat.runtimeLive = true
        nudge(acp, 2)
        await settle()
        expect(rotatedLines(acp)).toEqual([`${LINE} handoff=unknown`])
      },
      { config: { settleMs: 0 } }
    )
  })

  test('a wrkq handoff since the attention suppresses the line; an older one reads handoff=no', async () => {
    const calls: unknown[] = []
    await withC2Acp(
      async (acp) => {
        await settle()
        quit(acp)
        nudge(acp, 1)
        await settle()
        expect(acp.card().body['state']).toBe('superseded')
        expect(rotatedLines(acp)).toEqual([])
        expect(calls).toContainEqual(
          expect.objectContaining({ scopeRef: 'agent:smokey:project:c2', status: 'all' })
        )
      },
      // second precision, as wrkq stamps it: the same second as the attention counts
      { config: { settleMs: 0 }, workClient: fakeWorkClient('2026-11-01T05:00:00Z', calls) }
    )
    await withC2Acp(
      async (acp) => {
        await settle()
        quit(acp)
        nudge(acp, 1)
        await settle()
        expect(rotatedLines(acp)).toEqual([`${LINE} handoff=no`])
      },
      { config: { settleMs: 0 }, workClient: fakeWorkClient('2026-11-01T04:59:59Z', []) }
    )
  })
})
