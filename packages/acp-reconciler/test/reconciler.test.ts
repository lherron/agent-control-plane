import { describe, expect, test } from 'bun:test'

import { ReconcilerConfigError, readReconcilerConfig } from '../src/config.js'
import { parseRequestMarker } from '../src/model.js'
import type { ReconcilerWriter } from '../src/ports.js'
import { createReconcilerCore } from '../src/reconciler.js'
import { FakeWorld, testConfig } from './fake-world.js'

const WINDOW = testConfig.claimWindowMs

function core(world: FakeWorld, log: string[] = []) {
  return createReconcilerCore({
    config: testConfig,
    reader: world.reader(),
    writer: world.writer(),
    log: (line) => log.push(line),
    now: () => world.now,
  })
}

function decisionOf(result: Awaited<ReturnType<ReturnType<typeof core>['scanOnce']>>, id: string) {
  const decision = result.decisions.find((item) => item.id === id)
  if (decision === undefined) throw new Error(`no decision for ${id}`)
  return decision
}

describe('config', () => {
  test('unset designated node means not constructed', () => {
    expect(readReconcilerConfig({})).toBeUndefined()
  })
  test('spec defaults apply once a node is designated', () => {
    expect(readReconcilerConfig({ ACP_RECONCILER_NODE: 'max3' })).toEqual({
      node: 'max3',
      intervalMs: 45_000,
      globalCapacity: 4,
      agentCapacity: 2,
      claimWindowMs: 600_000,
      principalRef: 'agent:acp-reconciler',
    })
  })
  test('refuses unknown settings, out-of-range intervals and orphan settings', () => {
    expect(() =>
      readReconcilerConfig({ ACP_RECONCILER_NODE: 'max3', ACP_RECONCILER_ENABLED: '1' })
    ).toThrow(ReconcilerConfigError)
    expect(() =>
      readReconcilerConfig({ ACP_RECONCILER_NODE: 'max3', ACP_RECONCILER_INTERVAL_MS: '5000' })
    ).toThrow(/between/)
    expect(() =>
      readReconcilerConfig({ ACP_RECONCILER_NODE: 'max3', ACP_RECONCILER_GLOBAL_CAPACITY: 'four' })
    ).toThrow(/positive integer/)
    expect(() => readReconcilerConfig({ ACP_RECONCILER_GLOBAL_CAPACITY: '3' })).toThrow(/is not/)
    expect(() =>
      readReconcilerConfig({ ACP_RECONCILER_NODE: 'max3', ACP_RECONCILER_PRINCIPAL: 'acp' })
    ).toThrow(/agent:<id>/)
  })
})

describe('request marker', () => {
  test('accepts exactly { rev: positive integer }', () => {
    expect(parseRequestMarker({ acp: { request: { rev: 3 } } })).toEqual({ ok: true, rev: 3 })
    expect(parseRequestMarker({ other: 1 })).toBeUndefined()
    expect(parseRequestMarker({ acp: { workflow: {} } })).toBeUndefined()
  })
  test('refuses unknown fields and bad revs', () => {
    expect(parseRequestMarker({ acp: { request: { rev: 1, force: true } } })).toMatchObject({
      ok: false,
    })
    expect(parseRequestMarker({ acp: { request: { rev: 0 } } })).toMatchObject({ ok: false })
    expect(parseRequestMarker({ acp: { request: { rev: '1' } } })).toMatchObject({ ok: false })
    expect(parseRequestMarker({ acp: { request: null } })).toMatchObject({ ok: false })
  })
})

describe('reserve then start', () => {
  test('reserves before dispatch with the spec key and attributes, then dispatches once', async () => {
    const world = new FakeWorld()
    world.put({ id: 'T-1.diagram', ownerId: 'T-1' })
    const result = await core(world).scanOnce()
    expect(result.actions.map((action) => action.kind)).toEqual(['reserved', 'dispatched'])
    expect(world.facts).toHaveLength(1)
    expect(world.facts[0]).toMatchObject({
      task: 'T-1.diagram',
      type: 'delegation.started',
      key: 'recon:T-1.diagram:1:arris@proj:T-1.diagram',
      attributes: {
        requester: 'agent:mable',
        assignee_seat: 'arris@proj:T-1.diagram',
        rev: '1',
        start_key: 'recon:T-1.diagram:1:arris@proj:T-1.diagram',
      },
    })
    expect(world.dispatched).toHaveLength(1)
    expect(world.dispatched[0]?.startKey).toBe('recon:T-1.diagram:1:arris@proj:T-1.diagram')
    expect(world.dispatched[0]?.body).toContain('T-1.diagram@1')
    expect(world.dispatched[0]?.body).toContain('delegated-work')
  })

  test('rescans, a restart and a second loop copy never dispatch twice', async () => {
    const world = new FakeWorld()
    world.put({ id: 'T-2' })
    const first = core(world)
    await first.scanOnce()
    await first.scanOnce()
    await core(world).scanOnce() // restart: fresh process, same wrkq state
    const copy = core(world)
    await Promise.all([first.scanOnce(), copy.scanOnce()])
    expect(world.dispatched).toHaveLength(1)
  })

  test('two copies racing one key: the loser sees the fact and does not dispatch', async () => {
    const world = new FakeWorld()
    world.put({ id: 'T-3' })
    world.raceOnKey = 'recon:T-3:1:arris@proj:T-3'
    const result = await core(world).scanOnce()
    expect(result.actions.map((action) => action.kind)).toEqual(['reservation_existing'])
    expect(world.dispatched).toHaveLength(0)
  })

  test('a human assignee waits and is never started', async () => {
    const world = new FakeWorld()
    world.put({ id: 'T-4', assigneePrincipalRef: 'human:lance' })
    const result = await core(world).scanOnce()
    expect(decisionOf(result, 'T-4')).toMatchObject({ kind: 'wait' })
    expect(world.facts).toHaveLength(0)
  })

  test('an unknown agent, a bad marker, finished work and a gone owner never start', async () => {
    const world = new FakeWorld()
    world.invalidAgents.add('ghost')
    world.put({ id: 'T-5', assigneePrincipalRef: 'agent:ghost' })
    world.put({
      id: 'T-6',
      marker: { ok: false, reason: 'meta.acp.request.rev must be a positive integer' },
    })
    world.put({ id: 'T-7', state: 'completed' })
    world.put({ id: 'T-8.x', ownerId: 'T-8', ownerGone: true })
    world.put({ id: 'T-9', state: 'blocked' })
    const result = await core(world).scanOnce()
    expect(decisionOf(result, 'T-5')).toMatchObject({ kind: 'invalid' })
    expect(decisionOf(result, 'T-6')).toMatchObject({ kind: 'invalid' })
    expect(decisionOf(result, 'T-7')).toMatchObject({ kind: 'skip' })
    expect(decisionOf(result, 'T-8.x')).toMatchObject({ kind: 'skip' })
    expect(decisionOf(result, 'T-9')).toMatchObject({ kind: 'wait' })
    expect(world.writes).toBe(0)
  })

  test('a rev bump or a reassignment makes the old reservation stale and starts anew', async () => {
    const world = new FakeWorld()
    world.put({ id: 'T-10' })
    await core(world).scanOnce()
    world.put({ id: 'T-10', marker: { ok: true, rev: 2 } })
    await core(world).scanOnce()
    world.put({ id: 'T-10', marker: { ok: true, rev: 2 }, assigneePrincipalRef: 'agent:scribe' })
    await core(world).scanOnce()
    expect(world.dispatched.map((item) => item.startKey)).toEqual([
      'recon:T-10:1:arris@proj:T-10',
      'recon:T-10:2:arris@proj:T-10',
      'recon:T-10:2:scribe@proj:T-10',
    ])
  })
})

describe('capacity', () => {
  test('active claims and current reservations count; admission is by priority, age, id', async () => {
    const world = new FakeWorld()
    world.put({
      id: 'T-20',
      state: 'in_progress',
      claim: { by: 'agent:arris', scope: 's20', node: 'max3', generation: 1 },
    })
    world.put({ id: 'T-21', priority: 1 })
    world.put({ id: 'T-22', priority: 1, createdAt: '2026-10-01T11:10:00Z' })
    world.put({ id: 'T-23', priority: 2, assigneePrincipalRef: 'agent:scribe' })
    world.put({
      id: 'T-24',
      priority: 2,
      assigneePrincipalRef: 'agent:scribe',
      createdAt: '2026-10-01T11:30:00Z',
    })
    world.put({ id: 'T-25', priority: 4, assigneePrincipalRef: 'agent:cody' })
    world.liveness.set('s20', 'live')
    const result = await core(world).scanOnce()
    // arris: 1 claim + T-21 = 2 (T-22 waits on per-agent); global: 1 + T-21, T-23, T-24 = 4 (T-25 waits).
    expect(world.dispatched.map((item) => item.seat)).toEqual([
      'arris@proj:T-21',
      'scribe@proj:T-23',
      'scribe@proj:T-24',
    ])
    expect(decisionOf(result, 'T-22').reason).toMatch(/agent arris capacity 2\/2/)
    expect(decisionOf(result, 'T-25').reason).toMatch(/global capacity 4\/4/)
  })
})

describe('stalls', () => {
  test('unclaimed reservation past the window: one fact and one notice per episode', async () => {
    const world = new FakeWorld()
    world.put({ id: 'T-30' })
    const reconciler = core(world)
    await reconciler.scanOnce()
    world.advance(WINDOW - 1)
    expect((await reconciler.scanOnce()).actions).toEqual([])
    world.advance(2)
    const result = await reconciler.scanOnce()
    expect(result.actions).toEqual([
      {
        kind: 'stall_reported',
        id: 'T-30',
        key: 'stall:T-30:unclaimed_reservation:recon:T-30:1:arris@proj:T-30',
        notified: 'sent',
      },
    ])
    await reconciler.scanOnce()
    await core(world).scanOnce()
    expect(world.facts.filter((fact) => fact.type === 'delegation.stalled')).toHaveLength(1)
    expect(world.notices).toHaveLength(1)
    expect(world.notices[0]?.to).toBe('mable@proj:T-1')
  })

  test('a dispatch failure leaves the reservation, which the unclaimed rule then reports', async () => {
    const world = new FakeWorld()
    world.failDispatch = true
    world.put({ id: 'T-31' })
    const first = await core(world).scanOnce()
    expect(first.actions.map((action) => action.kind)).toEqual(['reserved', 'dispatch_failed'])
    world.failDispatch = false
    world.advance(WINDOW + 1)
    const later = await core(world).scanOnce()
    expect(later.actions.map((action) => action.kind)).toEqual(['stall_reported'])
    expect(world.dispatched).toHaveLength(0)
  })

  test('ended holder: per claim generation; unknown liveness never stalls', async () => {
    const world = new FakeWorld()
    const claim = {
      by: 'agent:arris',
      scope: 'agent:arris:project:proj:task:T-32/lane:main',
      node: 'max3',
      generation: 1,
    }
    world.put({ id: 'T-32', state: 'in_progress', claim })
    expect((await core(world).scanOnce()).actions).toEqual([])
    world.liveness.set(claim.scope, 'ended')
    await core(world).scanOnce()
    await core(world).scanOnce()
    world.put({ id: 'T-32', state: 'in_progress', claim: { ...claim, generation: 2 } })
    await core(world).scanOnce()
    expect(world.facts.map((fact) => fact.key)).toEqual([
      'stall:T-32:ended_holder:1',
      'stall:T-32:ended_holder:2',
    ])
    expect(world.notices).toHaveLength(2)
  })

  test('a holder on another node is unknown, never ended', async () => {
    const world = new FakeWorld()
    const claim = { by: 'agent:arris', scope: 'x', node: 'svc', generation: 1 }
    world.liveness.set('x', 'ended')
    world.put({ id: 'T-33', state: 'in_progress', claim })
    expect((await core(world).scanOnce()).actions).toEqual([])
  })

  test('orphaned in_progress: unclaimed, unreserved, past the window since its last update', async () => {
    const world = new FakeWorld()
    world.put({
      id: 'T-34',
      state: 'in_progress',
      claimGeneration: 3,
      requesterScopeRef: undefined,
      updatedAt: world.now.toISOString(),
    })
    expect((await core(world).scanOnce()).actions).toEqual([])
    world.advance(2 * WINDOW)
    const result = await core(world).scanOnce()
    expect(result.actions).toEqual([
      {
        kind: 'stall_reported',
        id: 'T-34',
        key: 'stall:T-34:orphaned_in_progress:3',
        notified: 'sent',
      },
    ])
    // No scope recorded: the notice goes to the scope-less requester principal.
    expect(world.notices[0]?.to).toBe('agent:mable')
  })

  test('no requester recorded: the fact is posted, no notice is sent', async () => {
    const world = new FakeWorld()
    world.put({
      id: 'T-35',
      state: 'in_progress',
      requesterPrincipalRef: undefined,
      requesterScopeRef: undefined,
    })
    world.advance(2 * WINDOW)
    const result = await core(world).scanOnce()
    expect(result.actions).toEqual([
      {
        kind: 'stall_reported',
        id: 'T-35',
        key: 'stall:T-35:orphaned_in_progress:0',
        notified: 'no_requester',
      },
    ])
    expect(world.notices).toHaveLength(0)
  })
})

describe('explain and logging', () => {
  test('explain is read-only: it never touches a writer', async () => {
    const world = new FakeWorld()
    world.put({ id: 'T-40' })
    world.put({ id: 'T-41', state: 'in_progress' })
    world.advance(2 * WINDOW)
    const refusing = new Proxy({} as ReconcilerWriter, {
      get: () => () => {
        throw new Error('explain wrote')
      },
    })
    const reconciler = createReconcilerCore({
      config: testConfig,
      reader: world.reader(),
      writer: refusing,
      log: () => {},
      now: () => world.now,
    })
    const result = await reconciler.explain()
    expect(result.decisions.map((decision) => [decision.id, decision.kind])).toEqual([
      ['T-40', 'start'],
      ['T-41', 'stall'],
    ])
    expect((await reconciler.explain('T-41')).decisions).toHaveLength(1)
    expect(world.facts).toHaveLength(0)
    expect(world.writes).toBe(0)
  })

  test('logs decision changes, not every scan of steady waiting state', async () => {
    const world = new FakeWorld()
    world.put({ id: 'T-50', assigneePrincipalRef: 'human:lance' })
    world.put({ id: 'T-51' })
    const log: string[] = []
    const reconciler = core(world, log)
    await reconciler.scanOnce()
    const afterFirst = log.length
    await reconciler.scanOnce()
    await reconciler.scanOnce()
    expect(afterFirst).toBe(3) // T-51 startable, reserved, dispatched
    expect(log).toHaveLength(afterFirst)
    expect(log.join('\n')).not.toContain('T-50')
  })

  test('start() on a non-designated node stays idle and scans nothing', async () => {
    const world = new FakeWorld()
    world.node = 'svc'
    world.put({ id: 'T-60' })
    const log: string[] = []
    const reconciler = core(world, log)
    await reconciler.start()
    await reconciler.stop()
    expect(world.writes).toBe(0)
    expect(log).toEqual(['acp-reconciler: idle; designated node max3, this node is svc'])
  })
})
