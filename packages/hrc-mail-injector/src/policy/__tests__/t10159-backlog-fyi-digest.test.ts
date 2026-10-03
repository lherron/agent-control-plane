import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type { HrcRuntimeIntent, HrcSessionRecord } from 'hrc-core'

import type { KickerDispatchOptions } from '../contracts.js'
import { observeBrokerLanding } from '../drive/landing.js'
import { reconcileOpenIntents } from '../drive/reconcile.js'
import { driveMailTargetOnce } from '../drive/target-driver.js'
import { formatBacklogDigest } from '../ledger/presentation.js'
import type { WrkqEnvelope } from '../ledger/types.js'
import { withdrawAckedQueuedInjection } from '../wake/ledger-tail.js'
import {
  RUNTIME_ID as RUNTIME,
  TARGET_REF as TARGET,
  brokerRecord,
  createT08094Harness,
  destroyT08094Harness,
} from './t08094-harness.js'
import type { T08094Harness } from './t08094-harness.js'

/**
 * T-10159 — backlog fyi is presented as ONE digest input (RCA R-00280).
 *
 * A fyi that waited for its seat (created before the receiving runtime was
 * born, or older than 15 minutes at drive time) is stale news. All of them in
 * one drive become a single submission listing each envelope, and each still
 * gets its own receipt and its own `fyi_presented` ack. A live fyi to a seated
 * idle reader is unchanged: one full-form submission.
 */

const INVOCATION = 'inv-t10159'
let h: T08094Harness
let prompts: Array<{ door: string; prompt: string; options: KickerDispatchOptions }>
let runtimeBornAt: number

function minutesBefore(at: number, minutes: number): string {
  return new Date(at - minutes * 60_000).toISOString()
}

beforeEach(async () => {
  h = await createT08094Harness()
  h.ledger.autoAckFyi = true
  const now = new Date().toISOString()
  h.db.brokerInvocations.insert({
    invocationId: INVOCATION,
    operationId: 'op-t10159',
    runtimeId: RUNTIME,
    brokerProtocol: 'harness-broker/0.2',
    brokerDriver: 'claude-code',
    invocationState: 'idle',
    capabilitiesJson: JSON.stringify({ admission: { classes: ['steer', 'queue'] } }),
    specHash: 'spec',
    startRequestHash: 'sr',
    selectedProfileHash: 'pf',
    createdAt: now,
    updatedAt: now,
  })
  h.db.runtimes.update(RUNTIME, {
    controllerKind: 'harness-broker',
    activeInvocationId: INVOCATION,
    updatedAt: now,
  })
  runtimeBornAt = Date.parse(h.db.runtimes.getByRuntimeId(RUNTIME)?.createdAt ?? now)
  h.context.port.seat = async () => ({
    runtimeId: RUNTIME,
    invocationId: INVOCATION,
    generation: 1,
    admissionClasses: ['steer', 'queue'],
    currentBrokerSeq: 0,
    probe: {
      invocationId: INVOCATION as never,
      seat: { state: 'idle' },
      brokerHeldDepth: 0,
    },
    probeError: null,
  })
  prompts = []
  let submissions = 0
  const door =
    (name: string) =>
    async (
      _session: HrcSessionRecord,
      _intent: HrcRuntimeIntent,
      prompt: string,
      options: KickerDispatchOptions
    ) => {
      submissions += 1
      prompts.push({ door: name, prompt, options })
      return { ...h.dispatchResult(), submissionId: `sub-${submissions}` }
    }
  h.context.port.steer = door('steer')
  h.context.port.enqueue = door('enqueue')
})

afterEach(async () => {
  await destroyT08094Harness(h)
})

function staleFyi(minutesBeforeBirth: number, body: string): WrkqEnvelope {
  return h.ledger.say({
    obligation: 'fyi',
    from: { principalRef: 'agent:foundry', scopeRef: 'foundry@wrkq:primary' },
    body,
    createdAt: minutesBefore(runtimeBornAt, minutesBeforeBirth),
  })
}

function intentLogs() {
  return h.logs.filter((log) => log.event === 'wrkq.kicker.delivery_intent')
}

describe('T-10159 — backlog fyi digest', () => {
  it('presents two fyis created before the runtime was born as ONE digest input', async () => {
    // Created before birth but only minutes old: the birth rule alone makes
    // them backlog, independent of the 15-minute age rule.
    const first = staleFyi(3, 'foundry: build 412 green\nsecond line is never shown')
    const second = staleFyi(2, 'foundry: build 413 green')

    await driveMailTargetOnce(h.context, TARGET, 'turn_completion')

    expect(prompts).toHaveLength(1)
    const [digest] = prompts
    expect(digest?.prompt).toContain('while you were away — 2 fyi, oldest 3m ago')
    expect(digest?.prompt).toContain(
      `${first.id} · foundry@wrkq:primary · 3m ago · foundry: build 412 green`
    )
    expect(digest?.prompt).toContain(
      `${second.id} · foundry@wrkq:primary · 2m ago · foundry: build 413 green`
    )
    expect(digest?.prompt).not.toContain('second line is never shown')
    expect(digest?.prompt).toContain('full text: wrkc show <EN-id>')
    // Oldest first.
    expect(digest?.prompt.indexOf(first.id)).toBeLessThan(digest?.prompt.indexOf(second.id) ?? -1)
    // Zero full presentations: every intent this drive opened is a digest member.
    expect(intentLogs().map((log) => log.detail['form'])).toEqual(['digest', 'digest'])

    const firstIntent = h.db.mailDelivery.getIntent(first.id)
    const secondIntent = h.db.mailDelivery.getIntent(second.id)
    expect(firstIntent?.submissionId).toBe('sub-1')
    expect(secondIntent?.submissionId).toBe('sub-1')

    await observeBrokerLanding(
      h.context,
      brokerRecord('submission.executed', { submissionId: 'sub-1' })
    )

    for (const envelope of [first, second]) {
      const row = h.ledger.envelopes.get(envelope.id)
      expect(row?.state).toBe('acked')
      expect(row?.reason).toBe('fyi_presented')
      expect(row?.presentedTo).toHaveLength(1)
      expect(row?.presentedTo[0]).toMatchObject({ runtimeId: RUNTIME, inputId: 'sub-1' })
      expect(h.db.mailDelivery.getIntent(envelope.id)).toBeUndefined()
    }
    const rows = [first, second].map((envelope) =>
      h.db.mailDelivery.getPresentation(envelope.id, RUNTIME)
    )
    expect(rows.map((row) => row?.inputId)).toEqual(['sub-1', 'sub-1'])
    expect(rows[0]?.landingHrcSeq).toBe(rows[1]?.landingHrcSeq ?? -1)
    expect(rows[0]?.presentationId).not.toBe(rows[1]?.presentationId)
  })

  it('negative control: a live fyi to an idle seated reader still lands full', async () => {
    const live = h.ledger.say({
      obligation: 'fyi',
      body: 'live news',
      createdAt: new Date(Math.max(Date.now(), runtimeBornAt + 1000)).toISOString(),
    })

    await driveMailTargetOnce(h.context, TARGET, 'insert')

    expect(prompts).toHaveLength(1)
    expect(prompts[0]?.prompt).not.toContain('while you were away')
    expect(prompts[0]?.prompt).toContain('live news')
    expect(intentLogs().map((log) => log.detail['form'])).toEqual(['full'])
    await observeBrokerLanding(
      h.context,
      brokerRecord('submission.executed', { submissionId: 'sub-1' })
    )
    expect(h.ledger.envelopes.get(live.id)?.state).toBe('acked')
  })

  it('reads the birth from the seat host session, not the all-runtimes scan', async () => {
    // Live specimen (T-10159 acceptance, EN-23151/EN-23152): the drive ran ~2s
    // after the runtime was born, the fyis were 30s old, and the all-runtimes
    // scan did not yield the newborn runtime, so both landed `full`.
    h.context.port.runtime = async () => undefined
    const first = staleFyi(1, 'a')
    const second = staleFyi(1, 'b')

    await driveMailTargetOnce(h.context, TARGET, 'periodic')

    expect(prompts).toHaveLength(1)
    expect(prompts[0]?.prompt).toContain('while you were away — 2 fyi')
    expect(prompts[0]?.prompt).toContain(first.id)
    expect(prompts[0]?.prompt).toContain(second.id)
  })

  it('a single backlog fyi still takes the digest form', async () => {
    const only = staleFyi(1, 'one stale line')
    await driveMailTargetOnce(h.context, TARGET, 'turn_completion')
    expect(prompts).toHaveLength(1)
    expect(prompts[0]?.prompt).toContain('while you were away — 1 fyi, oldest 1m ago')
    expect(prompts[0]?.prompt).toContain(only.id)
    expect(prompts[0]?.prompt).not.toContain('[T-08094 ·')
  })

  it('falls back to the 15-minute age rule only when the runtime birth is unknown', async () => {
    // Only the birth lookup fails: the seat probe's host-session read is the
    // first of the pass, the birth read is the second.
    const byHost = h.context.port.runtimesByHostSession.bind(h.context.port)
    let reads = 0
    h.context.port.runtimesByHostSession = async (hostSessionId) => {
      reads += 1
      if (reads === 2) throw new Error('runtime read failed')
      return byHost(hostSessionId)
    }
    const old = h.ledger.say({ obligation: 'fyi', createdAt: minutesBefore(Date.now(), 20) })
    const fresh = h.ledger.say({ obligation: 'fyi', createdAt: minutesBefore(Date.now(), 2) })

    await driveMailTargetOnce(h.context, TARGET, 'turn_completion')

    expect(prompts).toHaveLength(2)
    expect(h.logs.some((log) => log.event === 'wrkq.kicker.runtime_birth_unknown')).toBe(true)
    const digest = prompts.find((entry) => entry.prompt.includes('while you were away'))
    expect(digest?.prompt).toContain(old.id)
    expect(digest?.prompt).not.toContain(fresh.id)
    expect(intentLogs().map((log) => [log.detail['envelope'], log.detail['form']])).toEqual([
      [fresh.id, 'full'],
      [old.id, 'digest'],
    ])
  })

  it('keeps notify and reply_required per-envelope, delivered before the digest', async () => {
    const owed = h.ledger.say({
      obligation: 'reply_required',
      createdAt: minutesBefore(runtimeBornAt, 60),
    })
    const notify = h.ledger.say({
      obligation: 'notify',
      createdAt: minutesBefore(runtimeBornAt, 60),
    })
    const stale = staleFyi(60, 'stale fyi')

    await driveMailTargetOnce(h.context, TARGET, 'turn_completion')

    expect(prompts).toHaveLength(3)
    expect(prompts[0]?.prompt).toContain(`reply: wrkc say ${owed.id}`)
    expect(prompts[1]?.options.submissionOrigin?.envelopeId).toBe(notify.id)
    expect(prompts[2]?.prompt).toContain('while you were away — 1 fyi, oldest 1h ago')
    expect(prompts[2]?.prompt).toContain(stale.id)
    expect(prompts[2]?.prompt).not.toContain(owed.id)
  })

  it('refused digest admission acks and receipts nothing; all stay pending', async () => {
    const first = staleFyi(30, 'a')
    const second = staleFyi(20, 'b')
    h.context.port.steer = async () => ({
      ...h.dispatchResult(),
      admission: 'rejected',
      reason: 'invalid-state:stopping',
      submissionId: undefined,
    })

    await driveMailTargetOnce(h.context, TARGET, 'turn_completion')

    for (const envelope of [first, second]) {
      expect(h.ledger.envelopes.get(envelope.id)?.state).toBe('pending')
      expect(h.ledger.envelopes.get(envelope.id)?.presentedTo).toEqual([])
      expect(h.db.mailDelivery.getIntent(envelope.id)).toBeUndefined()
    }
    // The next drive retries them together, as a digest again.
    h.context.port.steer = async (_s, _i, prompt, options) => {
      prompts.push({ door: 'steer', prompt, options })
      return { ...h.dispatchResult(), submissionId: 'sub-retry' }
    }
    await driveMailTargetOnce(h.context, TARGET, 'periodic')
    expect(prompts).toHaveLength(1)
    expect(prompts[0]?.prompt).toContain('2 fyi')
  })

  it('a thrown digest door leaves every member fenced, none receipted', async () => {
    const first = staleFyi(30, 'a')
    const second = staleFyi(20, 'b')
    h.context.port.steer = async () => {
      throw new Error('socket reset')
    }

    await driveMailTargetOnce(h.context, TARGET, 'turn_completion')

    for (const envelope of [first, second]) {
      expect(h.ledger.envelopes.get(envelope.id)?.state).toBe('pending')
      expect(h.db.mailDelivery.getIntent(envelope.id)?.uncertainCause).toBe('dispatch_error')
    }
    // An open intent is the fence: a second drive presents nothing.
    await driveMailTargetOnce(h.context, TARGET, 'periodic')
    expect(prompts).toHaveLength(0)
  })

  it('drops a member acked between the pending view and the submission', async () => {
    const acked = staleFyi(30, 'already handled')
    const kept = staleFyi(20, 'still pending')
    const show = h.ledger.envelopeShow.bind(h.ledger)
    h.ledger.envelopeShow = async (params) => {
      const row = await show(params)
      if (row.id === acked.id) {
        row.state = 'acked'
        row.terminal = true
      }
      return row
    }

    await driveMailTargetOnce(h.context, TARGET, 'turn_completion')

    expect(prompts).toHaveLength(1)
    expect(prompts[0]?.prompt).toContain('while you were away — 1 fyi')
    expect(prompts[0]?.prompt).toContain(kept.id)
    expect(prompts[0]?.prompt).not.toContain(acked.id)
    expect(h.db.mailDelivery.getIntent(acked.id)).toBeUndefined()
  })

  it('an ack of one queued member does not withdraw the shared digest submission', async () => {
    const first = staleFyi(30, 'a')
    const second = staleFyi(20, 'b')
    const withdrawals: unknown[] = []
    h.context.port.withdraw = async (input: unknown) => {
      withdrawals.push(input)
      return { ok: true, response: { outcome: 'withdrawn' } } as never
    }
    await driveMailTargetOnce(h.context, TARGET, 'turn_completion')

    await withdrawAckedQueuedInjection(h.context, {
      id: 1,
      timestamp: new Date().toISOString(),
      resourceType: 'envelope',
      resourceId: first.id,
      eventType: 'envelope.acked',
      payload: JSON.stringify({ reason: 'operator' }),
    })
    expect(withdrawals).toEqual([])
    expect(h.db.mailDelivery.getIntent(first.id)?.terminalEnvelopeAt).toBeDefined()

    // The digest lands: the live sibling is receipted; the acked member is
    // audit-only and is not resurrected.
    h.ledger.envelopes.get(first.id)!.state = 'acked'
    h.ledger.envelopes.get(first.id)!.terminal = true
    await observeBrokerLanding(
      h.context,
      brokerRecord('submission.executed', { submissionId: 'sub-1' })
    )
    expect(h.ledger.envelopes.get(second.id)?.state).toBe('acked')
    expect(h.ledger.envelopes.get(second.id)?.presentedTo).toHaveLength(1)
    expect(h.ledger.envelopes.get(first.id)?.presentedTo).toEqual([])
  })

  it('reconcile lands the whole digest from one submission disposition', async () => {
    const first = staleFyi(30, 'a')
    const second = staleFyi(20, 'b')
    await driveMailTargetOnce(h.context, TARGET, 'turn_completion')
    h.db.brokerInvocationEvents.appendEvent({
      invocationId: INVOCATION,
      runtimeId: RUNTIME,
      seq: 3,
      time: new Date().toISOString(),
      type: 'submission.executed',
      payload: { submissionId: 'sub-1' },
    })

    const counts = await reconcileOpenIntents(h.context, { reason: 'test' })

    expect(counts.landed).toBe(1)
    for (const envelope of [first, second]) {
      expect(h.ledger.envelopes.get(envelope.id)?.state).toBe('acked')
      expect(h.db.mailDelivery.getIntent(envelope.id)).toBeUndefined()
    }
    expect(h.db.mailDelivery.getPresentation(first.id, RUNTIME)?.landingHrcSeq).toBe(
      h.db.mailDelivery.getPresentation(second.id, RUNTIME)?.landingHrcSeq ?? -1
    )
  })
})

describe('T-10159 — digest text', () => {
  it('renders header, one clipped first line per envelope oldest first, and the pointer', () => {
    const now = new Date('2026-10-03T21:40:00Z')
    const envelope = (id: string, createdAt: string, body: string): WrkqEnvelope => ({
      uuid: `uuid-${id}`,
      id,
      roomUuid: 'room',
      roomKey: 'R-00001',
      roomKind: 'adhoc',
      from: { principalRef: 'agent:foundry', scopeRef: 'agent:foundry:project:wrkq' },
      to: { principalRef: 'agent:mable', scopeRef: 'mable@wrkq:primary' },
      obligation: 'fyi',
      delivery: 'queue',
      body,
      state: 'pending',
      terminal: false,
      presentedTo: [],
      createdAt,
      updatedAt: createdAt,
    })
    const text = formatBacklogDigest(
      [
        envelope('EN-22852', '2026-10-03T08:27:00Z', 'short'),
        envelope('EN-22849', '2026-10-03T08:20:00Z', `${'x'.repeat(200)}\nmore`),
      ],
      now
    )
    expect(text).toBe(
      [
        '[while you were away — 2 fyi, oldest 13h ago]',
        `EN-22849 · foundry@wrkq · 13h ago · ${'x'.repeat(120)}…`,
        'EN-22852 · foundry@wrkq · 13h ago · short',
        'full text: wrkc show <EN-id>',
      ].join('\n')
    )
  })
})
