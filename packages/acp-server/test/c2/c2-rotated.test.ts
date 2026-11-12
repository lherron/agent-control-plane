/**
 * The rotated line through ACP (card contract rev 4 §6, §7: rotation is a non-event for rows). ACP's C2Host
 * answers `runtimeEnd` from the HRC runtime record (`GET /v1/runtimes?hostSessionId=…&all=true`) and the
 * runtime's `runtime.terminated` event (`GET /v1/events/tail?runtimeId=…`, T-12715), and `handoffSince` from
 * HRC's seat handoffs (`GET /v1/seat-handoffs?project=…&all=true`) and its wrkq client. A quit at the prompt of a seat
 * with an open row sends Vesta exactly one `[c2] rotated …` line, claimed once on `c2.ping{id: rotated}`, and
 * changes nothing on the asks record.
 */
import { describe, expect, test } from 'bun:test'

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
  acp.fake.touch(SEAT, 'runtime.state')
}

/**
 * A prae self-restart as max3 HRC recorded mable@hrc-runtime:primary gen 97→98 on 2026-11-07 (T-12715): the
 * runtime record ends `lifecycleTerminalReason: process-exit` with no `runtimeStateJson.terminationReason`, the
 * `runtime.terminated` event carries `{reason: self-restart, transport: hrcpty}`, and a new generation starts on a
 * new host session. `recordReason` adds an explicit record reason, as a quit at the prompt writes one.
 */
function selfRestart(acp: C2Acp, recordReason?: string): void {
  acp.fake.runtimes.push({
    runtimeId: 'rt-c2fixture-acp',
    hostSessionId: 'hsid-c2fixture-acp',
    scopeRef: SEAT,
    laneRef: 'main',
    generation: 2,
    status: 'terminated',
    statusChangedAt: '2026-11-07T14:13:59.977Z',
    lifecycleTerminalReason: 'process-exit',
    runtimeStateJson: recordReason === undefined ? {} : { terminationReason: recordReason },
    createdAt: '2026-11-07T13:51:00.000Z',
    updatedAt: '2026-11-07T14:13:59.977Z',
  })
  acp.fake.emit({
    eventKind: 'runtime.terminated',
    scopeRef: SEAT,
    hostSessionId: 'hsid-c2fixture-acp',
    generation: 2,
    runtimeId: 'rt-c2fixture-acp',
    payload: { transport: 'hrcpty', reason: 'self-restart' },
  })
  const seat = acp.fake.seats.get(SEAT)!
  seat.generation = 3
  seat.hostSessionId = 'hsid-c2fixture-acp-3'
  seat.runtimeId = 'rt-c2fixture-acp-3'
  seat.runtimeLive = true
  acp.fake.touch(SEAT, 'session.created')
}

/** An HRC seat handoff, keyed by the full seat scope as `prae seat handoff create` writes it. */
function hrcHandoff(acp: C2Acp, createdAt: string): void {
  acp.fake.handoffs.push({
    id: 'H-c2fixture-acp',
    scopeRef: SEAT,
    laneRef: 'main',
    title: 'Restart for context',
    body: '# Handoff',
    state: 'acknowledged',
    etag: 2,
    createdAt,
    acknowledgedAt: createdAt,
    note: null,
    legacyScope: null,
  })
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
        expect(rotatedLines(acp)).toEqual([`${LINE} handoff=no`])
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
        acp.fake.touch(SEAT, 'runtime.state')
        nudge(acp, 3)
        await settle()
        expect(rotatedLines(acp)).toEqual([`${LINE} handoff=no`])
        expect(acp.record()).toEqual(record)
      },
      { config: { settleMs: 0 } }
    )
  })

  describe('a prae self-restart (T-12715)', () => {
    const RESTART = `[c2] rotated ${SEAT} gen 2\u21923 reason=self-restart prior=rt-c2fixture-acp rows=ship`

    test('an HRC handoff since the record suppresses the line', async () => {
      await withC2Acp(
        async (acp) => {
          await settle()
          hrcHandoff(acp, '2099-01-01T00:00:00.000Z')
          selfRestart(acp)
          nudge(acp, 1)
          await settle()
          expect(rotatedLines(acp)).toEqual([])
          expect(
            acp.fake.calls.some(
              (c) =>
                c.path === '/v1/seat-handoffs' &&
                c.query['scopeRef'] === SEAT &&
                c.query['all'] === 'true'
            )
          ).toBe(true)
        },
        { config: { settleMs: 0 } }
      )
    })

    test('an older HRC handoff reads handoff=no and the reason is the runtime.terminated event', async () => {
      await withC2Acp(
        async (acp) => {
          await settle()
          hrcHandoff(acp, '2000-01-01T00:00:00.000Z')
          selfRestart(acp)
          nudge(acp, 1)
          await settle()
          expect(rotatedLines(acp)).toEqual([`${RESTART} handoff=no`])
        },
        { config: { settleMs: 0 } }
      )
    })

    test('a handoff of another agent, project or sibling seat does not count', async () => {
      await withC2Acp(
        async (acp) => {
          await settle()
          acp.fake.handoffs.push(
            ...[
              'agent:clod:project:c2:task:primary',
              'agent:smokey:project:c2x:task:primary',
              // A sibling seat of the same agent and project (live T-12715: t12715a's suppressed t12715b's).
              'agent:smokey:project:c2:task:c2fixture-other',
            ].map((scopeRef) => ({
              id: `H-${scopeRef}`,
              scopeRef,
              laneRef: 'main',
              title: '',
              body: '',
              state: 'pending' as const,
              etag: 1,
              createdAt: '2099-01-01T00:00:00.000Z',
              acknowledgedAt: null,
              note: null,
              legacyScope: null,
            }))
          )
          selfRestart(acp)
          nudge(acp, 1)
          await settle()
          expect(rotatedLines(acp)).toEqual([`${RESTART} handoff=no`])
        },
        { config: { settleMs: 0 } }
      )
    })

    test('an HRC handoff read that fails reads handoff=unknown when wrkq found none', async () => {
      await withC2Acp(
        async (acp) => {
          await settle()
          acp.fake.handoffsRefuse = { status: 503, code: 'session_home_pending' }
          selfRestart(acp)
          nudge(acp, 1)
          await settle()
          expect(rotatedLines(acp)).toEqual([`${RESTART} handoff=unknown`])
        },
        { config: { settleMs: 0 } }
      )
    })

    test('an explicit record reason that differs from the event is reported with it', async () => {
      await withC2Acp(
        async (acp) => {
          await settle()
          selfRestart(acp, 'user_initiated_session_end')
          nudge(acp, 1)
          await settle()
          expect(rotatedLines(acp)).toEqual([
            `[c2] rotated ${SEAT} gen 2\u21923 reason=self-restart/user_initiated_session_end prior=rt-c2fixture-acp rows=ship handoff=no`,
          ])
        },
        { config: { settleMs: 0 } }
      )
    })
  })
})
