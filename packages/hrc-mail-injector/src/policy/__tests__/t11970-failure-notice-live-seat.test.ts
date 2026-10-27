import { afterEach, beforeEach, describe, expect, it, setSystemTime } from 'bun:test'

import { deliverFailureNotices } from '../terminal/failure-notices.js'
import {
  type T08094Harness,
  TARGET_REF,
  createT08094Harness,
  destroyT08094Harness,
} from './t08094-harness.js'

// T-11970, max3 2026-10-27: EN-35866 expired and owed its sender, the completed
// cody T-11819 seat, a failure notice. Each pass enqueued into the session,
// HRC birthed a fresh codex runtime into the removed worktree, the broker never
// came up (ENOENT), and the next pass found that new runtime, hashed it into a
// new dispatch key, discarded the backoff and tried again at attempt 1, delay
// 0. A birth every ~31s until the row was stamped by hand.
describe('T-11970 — a failure notice rides a live seat and never births one', () => {
  let h: T08094Harness
  type SeatState = 'idle' | 'turn-active' | null
  let rows: Array<Record<string, unknown>>
  const probes = new Map<string, SeatState>()
  let born = 0

  function seatRuntime(runtimeId: string, state: SeatState): void {
    rows.push({
      runtimeId,
      hostSessionId: h.session.hostSessionId,
      generation: h.session.generation,
      status: 'ready',
      controllerKind: 'harness-broker',
      activeInvocationId: `inv-${runtimeId}`,
    })
    probes.set(runtimeId, state)
  }

  function enqueues(): number {
    return h.dispatches.filter((dispatch) => dispatch.submissionDoor === 'enqueue').length
  }

  function owed(): number {
    return h.store.mailDelivery.listUndeliveredFailureNotices(TARGET_REF).length
  }

  /** HRC's answer for a session whose seat is gone: birth one, and fail. */
  function enqueueBirthsADeadRuntime(): void {
    h.context.port.enqueue = async (_session, _intent, _prompt, options) => {
      h.dispatches.push({ ...options, submissionDoor: 'enqueue' })
      born += 1
      seatRuntime(`rt-born-${born}`, null)
      throw new Error(
        'POST /v1/submissions/enqueue 500: connect ENOENT /private/tmp/spaces-harness-broker-501/hb-codex-tui.app.sock'
      )
    }
  }

  beforeEach(async () => {
    h = await createT08094Harness()
    rows = []
    probes.clear()
    born = 0
    h.context.port.runtimesByHostSession = async () => rows as never
    h.context.port.seat = async (runtimeId: string) => {
      const state = probes.get(runtimeId) ?? null
      return {
        runtimeId,
        invocationId: `inv-${runtimeId}`,
        generation: h.session.generation,
        admissionClasses: ['enqueue'],
        currentBrokerSeq: 0,
        probe: state === null ? null : { seat: { state, turnId: 'turn-1' } },
        probeError:
          state === null ? { code: 'broker_unreachable', message: 'connect ENOENT' } : null,
      } as never
    }
    h.store.mailDelivery.recordFailureNotice({
      envelopeId: 'EN-35866',
      targetSessionRef: TARGET_REF,
      notice: 'reply_required to cody@hrc-runtime:T-11818 failed: undeliverable',
    })
  })

  afterEach(async () => {
    setSystemTime()
    await destroyT08094Harness(h)
  })

  it('submits nothing for a sender with no live seat, however many passes run', async () => {
    // The incident's state: the session's current generation holds a runtime
    // whose broker never answered.
    seatRuntime('rt-born-0', null)
    enqueueBirthsADeadRuntime()

    for (let pass = 0; pass < 10; pass += 1) {
      await deliverFailureNotices(h.context, TARGET_REF, h.session)
    }
    expect(enqueues()).toBe(0)
    expect(born).toBe(0)
    expect(owed()).toBe(1)

    // No runtime at all is the same: owed, not summoned.
    rows = []
    await deliverFailureNotices(h.context, TARGET_REF, h.session)
    expect(enqueues()).toBe(0)

    // A sender that comes back gets it then.
    h.context.port.enqueue = async (_session, _intent, _prompt, options) => {
      h.dispatches.push({ ...options, submissionDoor: 'enqueue' })
      return h.dispatchResult()
    }
    seatRuntime('rt-returned', 'idle')
    await deliverFailureNotices(h.context, TARGET_REF, h.session)
    expect(enqueues()).toBe(1)
    expect(owed()).toBe(0)
  })

  it('delivers once into a live seat', async () => {
    seatRuntime('rt-live', 'turn-active')
    for (let pass = 0; pass < 3; pass += 1) {
      await deliverFailureNotices(h.context, TARGET_REF, h.session)
    }
    expect(enqueues()).toBe(1)
    expect(owed()).toBe(0)
    expect(h.logs.map((entry) => entry.event)).toContain('wrkq.kicker.failure_notice_delivered')
  })

  it('keeps its backoff across a runtime change, then parks with a WARN', async () => {
    let now = Date.parse('2026-10-27T06:34:23Z')
    setSystemTime(new Date(now))
    let seat = 0
    const reseat = () => {
      seat += 1
      rows = []
      seatRuntime(`rt-live-${seat}`, 'idle')
    }
    reseat()
    h.context.port.enqueue = async (_session, _intent, _prompt, options) => {
      h.dispatches.push({ ...options, submissionDoor: 'enqueue' })
      throw new Error('participant attempt is DETACHED')
    }

    // Ten passes at one instant, a new runtime each: one try and its immediate
    // replay, nothing more.
    for (let pass = 0; pass < 10; pass += 1) {
      await deliverFailureNotices(h.context, TARGET_REF, h.session)
      reseat()
    }
    expect(enqueues()).toBe(2)

    // An hour apart, still reseating every pass: the budget runs out and the
    // notice parks instead of trying forever.
    for (let pass = 0; pass < 40; pass += 1) {
      now += 60 * 60_000
      setSystemTime(new Date(now))
      await deliverFailureNotices(h.context, TARGET_REF, h.session)
      reseat()
    }
    const parked = h.logs.filter((entry) => entry.event === 'wrkq.kicker.failure_notice_parked')
    expect(parked).toHaveLength(1)
    expect(parked[0]?.level).toBe('WARN')
    expect(parked[0]?.detail['reason']).toBe('attempts_exhausted')
    const spent = enqueues()
    expect(spent).toBeLessThan(10)
    expect(owed()).toBe(1)

    // A newly owed notice is a different set with a budget of its own.
    h.store.mailDelivery.recordFailureNotice({
      envelopeId: 'EN-35900',
      targetSessionRef: TARGET_REF,
      notice: 'a second reply_required failed',
    })
    await deliverFailureNotices(h.context, TARGET_REF, h.session)
    expect(enqueues()).toBe(spent + 1)
  })
})
