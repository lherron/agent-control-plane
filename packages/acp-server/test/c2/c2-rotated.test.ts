/**
 * The rotated line through ACP (card contract rev 4 §6, §7: rotation is a non-event for rows). ACP's C2Host
 * answers `runtimeEnd` from the HRC runtime record (`GET /v1/runtimes?hostSessionId=…&all=true`,
 * `runtimeStateJson.terminationReason`) and `handoffSince` from its wrkq client. A quit at the prompt of a seat
 * with an open row sends Vesta exactly one `[c2] rotated …` line, claimed once on `c2.ping{id: rotated}`, and
 * changes nothing on the asks record.
 */
import { describe, expect, test } from 'bun:test'

import type { WorkClient } from '@wrkq/client'

import { type C2Acp, SEAT, VESTA, settle, withC2Acp } from './c2-acp.js'

const VESTA_REF = `${VESTA}/lane:main`
const LINE = `[c2] rotated ${SEAT} gen 2\u2192none reason=user_initiated_session_end prior=rt-c2fixture-acp rows=ship`

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

describe('the rotated line over ACP', () => {
  test('a quit is ignored until HRC records it; then one line, the asks record untouched, nothing more on relaunch', async () => {
    await withC2Acp(
      async (acp) => {
        await settle()
        const record = structuredClone(acp.record())
        quit(acp, false)
        nudge(acp, 1)
        await settle()
        expect(rotatedLines(acp)).toEqual([])

        quit(acp)
        nudge(acp, 2)
        await settle()
        expect(rotatedLines(acp)).toEqual([`${LINE} handoff=unknown`])
        expect(acp.record()).toEqual(record)
        expect(acp.fake.find(SEAT, 'ping', 'rotated', null)?.body).toMatchObject({
          detector: 'rotated',
          generation: 2,
        })
        expect(
          acp.fake.calls.some(
            (c) =>
              c.path === '/v1/runtimes' &&
              c.query['hostSessionId'] === 'hsid-c2fixture-acp' &&
              c.query['all'] === 'true'
          )
        ).toBe(true)

        const seat = acp.fake.seats.get(SEAT)!
        seat.generation = 3
        seat.hostSessionId = 'hsid-c2fixture-acp-3'
        seat.runtimeLive = true
        nudge(acp, 3)
        await settle()
        expect(rotatedLines(acp)).toEqual([`${LINE} handoff=unknown`])
        expect(acp.record()).toEqual(record)
      },
      { config: { settleMs: 0 } }
    )
  })

  test('a wrkq handoff since the record suppresses the line; an older one reads handoff=no', async () => {
    const calls: unknown[] = []
    await withC2Acp(
      async (acp) => {
        await settle()
        quit(acp)
        nudge(acp, 1)
        await settle()
        expect(rotatedLines(acp)).toEqual([])
        expect(calls).toContainEqual(
          expect.objectContaining({ scopeRef: 'agent:smokey:project:c2', status: 'all' })
        )
      },
      { config: { settleMs: 0 }, workClient: fakeWorkClient('2099-01-01T00:00:00Z', calls) }
    )
    await withC2Acp(
      async (acp) => {
        await settle()
        quit(acp)
        nudge(acp, 1)
        await settle()
        expect(rotatedLines(acp)).toEqual([`${LINE} handoff=no`])
      },
      { config: { settleMs: 0 }, workClient: fakeWorkClient('2000-01-01T00:00:00Z', []) }
    )
  })
})
