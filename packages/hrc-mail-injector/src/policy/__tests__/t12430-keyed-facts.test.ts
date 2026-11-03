import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type { HrcLifecycleEvent, HrcSessionRecord } from 'hrc-core'

import { reportStalledDeliveries } from '../diagnostics/stranded.js'
import { noteBrokerEvidence, reconcileOpenIntents } from '../drive/reconcile.js'
import { driveMailTargetOnce } from '../drive/target-driver.js'
import { FOREIGN_HOME_TTL_MS, HrcFacts, hrcFacts } from '../facts/hrc-facts.js'
import { STEER_WRITE_RECONCILE_GRACE_MS } from '../internal.js'
import { runMailKickerSweep } from '../wake/sweep.js'
import type { T08094Harness } from './t08094-harness.js'
import {
  HOST_SESSION_ID,
  RUNTIME_ID,
  SCOPE_REF,
  TARGET_REF,
  brokerRecord,
  createT08094Harness,
  destroyT08094Harness,
} from './t08094-harness.js'

/**
 * T-12430: keyed HRC facts fed by the lifecycle follow, and reconcile evidence
 * reads keyed to broker commit notifications. The cases follow
 * `var/wrkq-artifacts/T-12430/failure-modes.md`.
 */

const READS = [
  'runtime',
  'runtimesByHostSession',
  'liveRuntimes',
  'liveSessionRefs',
  'seat',
  'resolveForeignHome',
  'targetBySessionRef',
  'eventsHead',
  'lifecycleEvents',
  'brokerEventsQuery',
  'localPlacementBindings',
  'locate',
  'unbornDesignations',
  'federatedLiveRuntimes',
] as const
type ReadName = (typeof READS)[number]

let h: T08094Harness
let calls: Map<ReadName, number>

function countReads(): void {
  calls = new Map()
  const port = h.context.port as unknown as Record<string, (...args: unknown[]) => unknown>
  for (const name of READS) {
    const original = port[name]
    if (typeof original !== 'function') continue
    port[name] = (...args: unknown[]) => {
      calls.set(name, (calls.get(name) ?? 0) + 1)
      return original.apply(h.context.port, args)
    }
  }
}

function total(): number {
  let sum = 0
  for (const count of calls.values()) sum += count
  return sum
}

function reset(): void {
  calls.clear()
}

function attach(): HrcFacts {
  const facts = hrcFacts(h.context)
  facts.attachLifecycle()
  facts.attachBroker()
  return facts
}

function event(eventKind: string, overrides: Partial<HrcLifecycleEvent> = {}): HrcLifecycleEvent {
  return {
    hrcSeq: 1,
    streamSeq: 1,
    ts: new Date().toISOString(),
    hostSessionId: HOST_SESSION_ID,
    scopeRef: SCOPE_REF,
    laneRef: 'main',
    generation: 1,
    runtimeId: RUNTIME_ID,
    category: 'runtime',
    eventKind,
    replayed: false,
    payload: {},
    ...overrides,
  } as HrcLifecycleEvent
}

const OTHER_REF = 'agent:cody:project:agent-control-plane:task:T-other/lane:main'

/** One in-flight steer and one settled-uncertain enqueue, both on RUNTIME_ID. */
function openAttempts(): void {
  h.store.mailDelivery.openIntent({
    envelopeId: 'EN-12430',
    targetSessionRef: TARGET_REF,
    door: 'enqueue',
    form: 'full',
    presentationId: 'present-12430',
    runtimeId: RUNTIME_ID,
    submittedHrcSeq: 1,
  })
  h.store.mailDelivery.attachAdmission('EN-12430', { submissionId: 'sub-12430' })
  h.store.mailDelivery.openIntent({
    envelopeId: 'EN-12431',
    targetSessionRef: TARGET_REF,
    door: 'enqueue',
    form: 'full',
    presentationId: 'present-12431',
    runtimeId: RUNTIME_ID,
    submittedHrcSeq: 1,
  })
  h.store.mailDelivery.attachAdmission('EN-12431', { submissionId: 'sub-12431' })
  h.store.mailDelivery.markUncertain(
    'EN-12431',
    'submission.expired',
    'refusal_without_no_write_proof'
  )
}

beforeEach(async () => {
  h = await createT08094Harness()
  h.context.drainTarget = async (targetSessionRef) => {
    await driveMailTargetOnce(h.context, targetSessionRef, 'periodic')
  }
  countReads()
})

afterEach(async () => {
  await destroyT08094Harness(h)
})

describe('T-12430 unchanged state makes no periodic HRC reads', () => {
  it('an unchanged outstanding attempt over N sweeps makes zero periodic HTTP reads', async () => {
    attach()
    openAttempts()
    await runMailKickerSweep.call(h.context)
    await driveMailTargetOnce(h.context, TARGET_REF, 'periodic')
    expect(calls.get('brokerEventsQuery') ?? 0).toBeGreaterThan(0)

    reset()
    for (let sweep = 0; sweep < 10; sweep += 1) {
      await runMailKickerSweep.call(h.context)
      await driveMailTargetOnce(h.context, TARGET_REF, 'periodic')
    }
    expect(Object.fromEntries(calls)).toEqual({})
  })

  it('without the lifecycle follow every read still goes to HRC (degraded mode)', async () => {
    openAttempts()
    await driveMailTargetOnce(h.context, TARGET_REF, 'periodic')
    reset()
    await driveMailTargetOnce(h.context, TARGET_REF, 'periodic')
    expect(calls.get('targetBySessionRef')).toBe(1)
    expect(calls.get('resolveForeignHome')).toBe(1)
  })
})

describe('T-12430 a lifecycle event dirties exactly its key', () => {
  it('a structural event re-reads its own target and leaves another alone', async () => {
    const facts = attach()
    await facts.target(TARGET_REF)
    await facts.target(OTHER_REF)
    await facts.liveSessionRefs()
    reset()

    facts.observe(event('runtime.created'))
    await facts.target(TARGET_REF)
    await facts.target(OTHER_REF)
    await facts.liveSessionRefs()
    expect(calls.get('targetBySessionRef')).toBe(1)
    expect(calls.get('liveSessionRefs')).toBe(1)
  })

  it('a benign event dirties nothing', async () => {
    const facts = attach()
    await facts.target(TARGET_REF)
    await facts.foreignHome(SCOPE_REF)
    await facts.liveSessionRefs()
    reset()
    for (const kind of [
      'turn.tool_call',
      'turn.completed',
      'broker.seat.transition',
      'runtime.context.updated',
    ]) {
      facts.observe(event(kind))
    }
    await facts.target(TARGET_REF)
    await facts.foreignHome(SCOPE_REF)
    await facts.liveSessionRefs()
    expect(total()).toBe(0)
  })

  it('F1: an unknown event kind dirties its keys', async () => {
    const facts = attach()
    await facts.target(TARGET_REF)
    await facts.foreignHome(SCOPE_REF)
    reset()
    facts.observe(event('session.teleported'))
    await facts.target(TARGET_REF)
    await facts.foreignHome(SCOPE_REF)
    expect(calls.get('targetBySessionRef')).toBe(1)
    expect(calls.get('resolveForeignHome')).toBe(1)
  })

  it('F1/F4: a benign event from a rotated host dirties the target', async () => {
    const facts = attach()
    await facts.target(TARGET_REF)
    reset()
    facts.observe(event('turn.tool_call', { generation: 1 }))
    await facts.target(TARGET_REF)
    expect(total()).toBe(0)
    facts.observe(event('turn.tool_call', { hostSessionId: 'hsid-rotated' }))
    await facts.target(TARGET_REF)
    facts.observe(event('turn.tool_call', { generation: 2 }))
    await facts.target(TARGET_REF)
    expect(calls.get('targetBySessionRef')).toBe(2)
  })

  it('F3: a server.started event resets every key', async () => {
    const facts = attach()
    await facts.target(TARGET_REF)
    await facts.target(OTHER_REF)
    await facts.liveSessionRefs()
    reset()
    facts.observe(event('server.started', { scopeRef: undefined, laneRef: undefined } as never))
    await facts.target(TARGET_REF)
    await facts.target(OTHER_REF)
    await facts.liveSessionRefs()
    expect(calls.get('targetBySessionRef')).toBe(2)
    expect(calls.get('liveSessionRefs')).toBe(1)
  })

  it('F4: an invalidation during an in-flight read is not overwritten', async () => {
    const facts = attach()
    let release: ((session: HrcSessionRecord) => void) | undefined
    h.context.port.targetBySessionRef = () =>
      new Promise<HrcSessionRecord | undefined>((resolve) => {
        release = resolve
      })
    const stale = facts.target(TARGET_REF)
    facts.observe(event('session.created'))
    release?.(h.session)
    expect(await stale).toBe(h.session)
    let reads = 0
    h.context.port.targetBySessionRef = async () => {
      reads += 1
      return h.session
    }
    await facts.target(TARGET_REF)
    expect(reads).toBe(1)
  })
})

describe('T-12430 the action fence still reads fresh', () => {
  it('a drive with actionable mail re-reads target, home and seat every pass', async () => {
    attach()
    h.ledger.say()
    for (let pass = 0; pass < 3; pass += 1) {
      // Each pass finds the mail actionable again.
      for (const intent of h.store.mailDelivery.listOpenIntents()) {
        h.store.mailDelivery.clearIntent(intent.envelopeId)
      }
      reset()
      await driveMailTargetOnce(h.context, TARGET_REF, 'insert')
      // At least the fence's own reads; a sender lookup or birth may add more.
      expect(calls.get('targetBySessionRef')).toBeGreaterThanOrEqual(1)
      expect(calls.get('resolveForeignHome')).toBeGreaterThanOrEqual(1)
      // Seat selection is never cached.
      expect(calls.get('runtimesByHostSession')).toBeGreaterThanOrEqual(1)
    }
  })

  it('F6: a cached absent session is re-read before any birth', async () => {
    attach()
    const hrc: { session: HrcSessionRecord | undefined } = { session: undefined }
    h.context.port.targetBySessionRef = async () => hrc.session
    await driveMailTargetOnce(h.context, TARGET_REF, 'periodic')
    hrc.session = h.session
    h.ledger.say()
    h.logs.length = 0
    await driveMailTargetOnce(h.context, TARGET_REF, 'insert')
    // The fence found the session the cache did not have, so the pass went
    // through seat selection rather than the no-session birth.
    const phases = h.logs.filter((log) => log.event === 'wrkq.kicker.drive_phase')
    expect(
      phases.some(
        (log) => log.detail['phase'] === 'action_fence' && log.detail['sessionFound'] === true
      )
    ).toBe(true)
    expect(phases.some((log) => log.detail['reason'] === 'no_target_session')).toBe(false)
  })
})

describe('T-12430 reconnect does one bounded catch-up', () => {
  it('a resume re-reads each key and each attempt once, then nothing', async () => {
    const facts = attach()
    openAttempts()
    await runMailKickerSweep.call(h.context)
    await driveMailTargetOnce(h.context, TARGET_REF, 'periodic')

    facts.lifecycleStreamState('down')
    facts.brokerStreamState('down')
    expect(facts.serving).toBe(false)
    facts.lifecycleStreamState('resumed')
    facts.brokerStreamState('resumed')

    reset()
    await runMailKickerSweep.call(h.context)
    await driveMailTargetOnce(h.context, TARGET_REF, 'periodic')
    expect(calls.get('liveSessionRefs')).toBe(1)
    expect(calls.get('targetBySessionRef')).toBe(1)
    expect(calls.get('brokerEventsQuery') ?? 0).toBeGreaterThan(0)

    reset()
    for (let sweep = 0; sweep < 5; sweep += 1) {
      await runMailKickerSweep.call(h.context)
      await driveMailTargetOnce(h.context, TARGET_REF, 'periodic')
    }
    expect(total()).toBe(0)
  })
})

describe('T-12430 broker evidence keyed to outstanding deliveries', () => {
  async function examinedEnvelopes(): Promise<string[]> {
    const examined: string[] = []
    const original = h.context.port.brokerEventsQuery
    h.context.port.brokerEventsQuery = async (op) => {
      if ('submissionId' in op) examined.push(op.submissionId)
      return await original(op)
    }
    await reconcileOpenIntents(h.context, { reason: 'periodic' })
    h.context.port.brokerEventsQuery = original
    return [...new Set(examined)]
  }

  it('a commit naming one submission re-reads that attempt only', async () => {
    attach()
    openAttempts()
    await reconcileOpenIntents(h.context, { reason: 'periodic' })
    expect(await examinedEnvelopes()).toEqual([])

    noteBrokerEvidence(
      h.context,
      brokerRecord('submission.milestone', { submissionId: 'sub-12430' })
    )
    expect(await examinedEnvelopes()).toEqual(['sub-12430'])
    expect(await examinedEnvelopes()).toEqual([])
  })

  it('a commit on the runtime with no submission id leaves bound attempts alone', async () => {
    attach()
    openAttempts()
    await reconcileOpenIntents(h.context, { reason: 'periodic' })
    noteBrokerEvidence(h.context, brokerRecord('turn.started', {}))
    noteBrokerEvidence(h.context, brokerRecord('turn.tool_call', {}))
    expect(await examinedEnvelopes()).toEqual([])
  })

  it('F7: a commit before the intent is recorded is still reconciled', async () => {
    attach()
    noteBrokerEvidence(
      h.context,
      brokerRecord('submission.executed', { submissionId: 'sub-12430' })
    )
    openAttempts()
    expect((await examinedEnvelopes()).sort()).toEqual(['sub-12430', 'sub-12431'])
  })

  it('F8: an intent is re-read once when its deadline passes', async () => {
    attach()
    h.store.mailDelivery.openIntent({
      envelopeId: 'EN-12432',
      targetSessionRef: TARGET_REF,
      door: 'steer',
      form: 'full',
      presentationId: 'present-12432',
      runtimeId: RUNTIME_ID,
      submittedHrcSeq: 1,
    })
    h.store.mailDelivery.attachAdmission('EN-12432', { submissionId: 'sub-12432' })
    expect(await examinedEnvelopes()).toEqual(['sub-12432'])
    expect(await examinedEnvelopes()).toEqual([])
    const memo = hrcFacts(h.context).reconcileMemo.get('EN-12432')
    if (memo === undefined) throw new Error('reconcile memo missing')
    // The last examination predates the steer grace boundary.
    memo.examinedAtMs -= STEER_WRITE_RECONCILE_GRACE_MS + 1_000
    h.storeSql
      .query('UPDATE hrcmail_delivery_intents SET submitted_at = ? WHERE envelope_id = ?')
      .run(new Date(Date.now() - STEER_WRITE_RECONCILE_GRACE_MS - 500).toISOString(), 'EN-12432')
    expect(await examinedEnvelopes()).toEqual(['sub-12432'])
    expect(await examinedEnvelopes()).toEqual([])
  })

  it('F10: a failed examination is retried next pass', async () => {
    attach()
    openAttempts()
    const original = h.context.port.brokerEventsQuery
    h.context.port.brokerEventsQuery = async () => {
      throw new Error('hrc unavailable')
    }
    await reconcileOpenIntents(h.context, { reason: 'periodic' })
    h.context.port.brokerEventsQuery = original
    expect((await examinedEnvelopes()).sort()).toEqual(['sub-12430', 'sub-12431'])
    expect(await examinedEnvelopes()).toEqual([])
  })
})

describe('T-12430 placement verdicts', () => {
  it('F5: a foreign verdict expires and a birth refusal drops the home', async () => {
    let clock = 1_000_000
    let reads = 0
    const foreign = { homeNodeId: 'svc', source: 'registry' as const }
    const facts = new HrcFacts(
      () =>
        ({
          resolveForeignHome: async () => {
            reads += 1
            return foreign
          },
        }) as never,
      () => clock
    )
    facts.attachLifecycle()
    await facts.foreignHome(SCOPE_REF)
    await facts.foreignHome(SCOPE_REF)
    expect(reads).toBe(1)
    clock += FOREIGN_HOME_TTL_MS
    await facts.foreignHome(SCOPE_REF)
    expect(reads).toBe(2)
    facts.invalidateTarget(TARGET_REF)
    await facts.foreignHome(SCOPE_REF)
    expect(reads).toBe(3)
  })
})

describe('T-12430 stalled launch checks', () => {
  it('a declined recovery is not re-read until its scope changes', async () => {
    const facts = attach()
    // A months-old launch fence whose envelope already went terminal in wrkq,
    // on a scope with no live runtime: recovery declines every time.
    const envelope = h.ledger.say({ state: 'acked', terminal: true })
    h.store.mailDelivery.openIntent({
      envelopeId: envelope.id,
      targetSessionRef: OTHER_REF,
      door: 'launch',
      form: 'full',
      presentationId: 'present-old-launch',
      submittedHrcSeq: 1,
    })
    h.storeSql
      .query('UPDATE hrcmail_delivery_intents SET submitted_at = ? WHERE envelope_id = ?')
      .run('2026-09-18T12:46:44.156Z', envelope.id)

    await reportStalledDeliveries(h.context)
    expect(calls.get('liveRuntimes')).toBe(1)
    for (let sweep = 0; sweep < 5; sweep += 1) await reportStalledDeliveries(h.context)
    expect(calls.get('liveRuntimes')).toBe(1)

    facts.observe(event('runtime.created', { scopeRef: OTHER_REF.replace('/lane:main', '') }))
    await reportStalledDeliveries(h.context)
    expect(calls.get('liveRuntimes')).toBe(2)
    expect(h.store.mailDelivery.getIntent(envelope.id)).toBeDefined()
  })
})
