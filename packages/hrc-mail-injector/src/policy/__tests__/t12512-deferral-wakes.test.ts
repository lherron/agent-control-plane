import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import {
  forgetDeferredWake,
  nextDeferredWakeAt,
  observeDeferredWake,
  stopDeferredWakes,
} from '../wake/deferred.js'
import type { T08094Harness } from './t08094-harness.js'
import { TARGET_REF, createT08094Harness, destroyT08094Harness } from './t08094-harness.js'

let h: T08094Harness
let wakes: string[]
let reads: number

beforeEach(async () => {
  h = await createT08094Harness()
  wakes = []
  reads = 0
  h.context.wake = (target) => {
    wakes.push(target)
  }
  h.context.ledger.pendingView = async (params) => {
    expect(params.scopes).toEqual([TARGET_REF])
    reads += 1
    return {
      items: [...h.ledger.envelopes.values()].map((envelope) => ({
        ...envelope,
        state: 'pending' as const,
      })),
      blocking: [],
      repended: 1,
    }
  }
})

afterEach(async () => {
  h.context.stopping = true
  await stopDeferredWakes(h.context)
  await destroyT08094Harness(h)
})

describe('T-12512 event-driven deferral deadlines', () => {
  it('repends an overdue deferral once and wakes only its target', async () => {
    const envelope = h.ledger.say({ state: 'deferred', retryAt: '2020-01-01T00:00:00Z' })
    await observeDeferredWake(h.context, envelope.id)
    await Bun.sleep(30)
    expect(reads).toBe(1)
    expect(wakes).toEqual([TARGET_REF])
    await Bun.sleep(30)
    expect(reads).toBe(1)
  })

  it('keeps a due envelope until the ledger exposes it on a bounded re-arm', async () => {
    const envelope = h.ledger.say({ state: 'deferred', retryAt: '2020-01-01T00:00:00Z' })
    h.context.ledger.pendingView = async () => {
      reads += 1
      if (reads === 1) return { items: [], blocking: [], repended: 0 }
      envelope.state = 'pending'
      return { items: [envelope], blocking: [], repended: 1 }
    }
    await observeDeferredWake(h.context, envelope.id)
    await Bun.sleep(50)
    expect(reads).toBe(1)
    expect(wakes).toEqual([])
    expect(Number.isFinite(nextDeferredWakeAt(h.context))).toBe(true)
    await Bun.sleep(1100)
    expect(reads).toBe(2)
    expect(wakes).toEqual([TARGET_REF])
    expect(nextDeferredWakeAt(h.context)).toBe(Number.POSITIVE_INFINITY)
  })

  it('gives the ledger a full second beyond its whole-second retry boundary', async () => {
    const at = Math.ceil((Date.now() + 60_000) / 1000) * 1000
    const envelope = h.ledger.say({ state: 'deferred', retryAt: new Date(at).toISOString() })
    await observeDeferredWake(h.context, envelope.id)
    expect(nextDeferredWakeAt(h.context)).toBe(at + 1000)
  })

  it('does no idle remote reads and cancels a terminal deferral before it is due', async () => {
    const envelope = h.ledger.say({
      state: 'deferred',
      retryAt: new Date(Date.now() + 60_000).toISOString(),
    })
    await observeDeferredWake(h.context, envelope.id)
    forgetDeferredWake(h.context, envelope.id)
    await Bun.sleep(30)
    expect(reads).toBe(0)
    expect(wakes).toEqual([])
  })

  it('ignores indefinite deferrals and foreign recipients', async () => {
    const indefinite = h.ledger.say({ state: 'deferred' })
    await observeDeferredWake(h.context, indefinite.id)
    h.context.port.resolveForeignHome = async () => ({ homeNodeId: 'svc', source: 'registry' })
    const foreign = h.ledger.say({ state: 'deferred', retryAt: '2020-01-01T00:00:00Z' })
    await observeDeferredWake(h.context, foreign.id)
    await Bun.sleep(30)
    expect(reads).toBe(0)
    expect(wakes).toEqual([])
  })

  it('retains due work after a failed repend and logs a bounded retry', async () => {
    h.context.ledger.pendingView = async () => {
      reads += 1
      throw new Error('wrkq offline')
    }
    const envelope = h.ledger.say({ state: 'deferred', retryAt: '2020-01-01T00:00:00Z' })
    await observeDeferredWake(h.context, envelope.id)
    await Bun.sleep(50)
    expect(reads).toBe(1)
    expect(wakes).toEqual([])
    expect(h.logs.some((entry) => entry.event === 'wrkq.kicker.deferral_wake_failed')).toBe(true)
  })

  it('stop waits for an in-flight repend and suppresses its late wake', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    h.context.ledger.pendingView = async () => {
      reads += 1
      await gate
      return { items: [], blocking: [], repended: 1 }
    }
    const envelope = h.ledger.say({ state: 'deferred', retryAt: '2020-01-01T00:00:00Z' })
    await observeDeferredWake(h.context, envelope.id)
    await Bun.sleep(30)
    expect(reads).toBe(1)
    h.context.stopping = true
    const stopped = stopDeferredWakes(h.context)
    release()
    await stopped
    expect(wakes).toEqual([])
  })
})
