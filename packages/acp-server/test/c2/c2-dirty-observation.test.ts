/** Event-only C2 observation, recovery, membership, and final action fences. */
import { afterEach, expect, test } from 'bun:test'

import { HrcClient } from 'hrc-sdk'

import { type C2HrcHost, createC2HrcHost } from '../../src/c2/hrc-adapter.js'
import { VESTA, fixtureSeats } from './c2-acp.js'
import { type FakeHrc, startFakeHrc } from './fake-hrc.js'

const WATCHED = Array.from({ length: 6 }, (_, i) => `agent:mable:project:dirty:task:seat-${i}`)
const READS = new Set(['/v1/sessions/attention', '/v1/sessions/annotations'])

let fake: FakeHrc | undefined
let host: C2HrcHost | undefined
const logs: string[] = []

afterEach(async () => {
  host?.close()
  await fake?.stop()
  host = undefined
  fake = undefined
  logs.length = 0
})

async function until(what: string, cond: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(5)
  }
}

function boot(): { fake: FakeHrc; host: C2HrcHost } {
  const template = fixtureSeats().find((seat) => seat.scopeRef === VESTA)!
  fake = startFakeHrc([
    template,
    ...WATCHED.map((scopeRef, i) => ({ ...template, scopeRef, hostSessionId: `hs-dirty-${i}` })),
  ])
  fake.put({
    scopeRef: VESTA,
    subject: 'seat',
    kind: 'config',
    id: 'scope',
    body: { v: 1, allow: ['^agent:mable:project:dirty:task:seat-[0-9]+$'] },
  })
  host = createC2HrcHost({
    client: new HrcClient({ socketPath: fake.socketPath }),
    vestaSeat: VESTA,
    principal: 'system:c2-controller',
    node: 'max3',
    ownsUnscoped: true,
    literalInputTimeoutMs: 1000,
    log: (line) => logs.push(line),
  })
  return { fake, host }
}

/** Per-seat read calls since the last `reset`. */
function readsBySeat(f: FakeHrc): Map<string, number> {
  const out = new Map<string, number>()
  for (const call of f.calls) {
    if (call.method !== 'GET' || !READS.has(call.path)) continue
    const scopeRef = call.query['scopeRef'] ?? ''
    out.set(scopeRef, (out.get(scopeRef) ?? 0) + 1)
  }
  return out
}

function reset(f: FakeHrc): void {
  f.calls.length = 0
}

/** Boot, wait for the follower, and take the full read its connect owes. */
async function following() {
  const booted = boot()
  await booted.host.seats()
  await until('the follower', () => booted.fake.events.followers() === 1)
  await booted.host.seats()
  reset(booted.fake)
  return booted
}

/** Let an event cross the follow stream. */
const delivered = () => Bun.sleep(50)

test('idle watched seats are not re-read', async () => {
  const { fake, host } = await following()
  for (let i = 0; i < 5; i += 1) {
    const [seats, rows] = await Promise.all([host.seats(), host.annotations()])
    expect(seats.map((s) => s.scopeRef)).toEqual([VESTA, ...WATCHED])
    expect(rows.some((row) => row.id === 'scope')).toBe(true)
  }
  expect(readsBySeat(fake).size).toBe(0)
})

test('an event for seat X re-reads only X on the next read', async () => {
  const { fake, host } = await following()
  const x = WATCHED[3]!
  fake.seats.get(x)!.attention = {
    source: 'jev',
    state: 'needs_input',
    kind: 'question',
    at: '2026-11-03T15:00:00.000Z',
  }
  fake.touch(x, 'turn.message')
  await delivered()
  const seats = await host.seats()
  expect([...readsBySeat(fake)]).toEqual([[x, 2]])
  expect(seats.find((s) => s.scopeRef === x)?.attention?.state).toBe('needs_input')
  reset(fake)
  await host.seats()
  expect(readsBySeat(fake).size).toBe(0)
})

test('an annotation change on a seat shows up in the next snapshot', async () => {
  const { fake, host } = await following()
  const y = WATCHED[1]!
  const changes: number[] = []
  host.onChange(() => changes.push(Date.now()))
  fake.put({
    scopeRef: y,
    subject: 'seat',
    ns: 'hrc',
    kind: 'asks',
    id: 'open',
    body: { v: 1, questions: [] },
  })
  await delivered()
  const rows = await host.annotations()
  expect(rows.filter((row) => row.scopeRef === y).map((row) => row.kind)).toEqual(['asks'])
  expect([...readsBySeat(fake).keys()]).toEqual([y])
  expect(changes).toHaveLength(1)

  // A delete is evented too.
  reset(fake)
  await host.delete(
    { sessionRef: `${y}/lane:main`, subject: 'seat', ns: 'hrc', kind: 'asks', id: 'open' },
    undefined,
    'agent:lance'
  )
  await delivered()
  expect((await host.annotations()).filter((row) => row.scopeRef === y)).toEqual([])
  expect([...readsBySeat(fake).keys()]).toEqual([y])
})

test('a dropped follower retains the cache; reconnect performs exactly one resync', async () => {
  const { fake, host } = await following()
  fake.events.enabled = false
  fake.events.drop()
  await until('down', () => logs.some((l) => l.includes('follow.down')))
  reset(fake)
  for (let i = 0; i < 3; i++) await host.seats()
  expect(readsBySeat(fake).size).toBe(0)
  fake.events.enabled = true
  await until('reconnect', () => fake.events.followers() === 1)
  await delivered()
  reset(fake)
  await host.seats()
  expect(readsBySeat(fake).size).toBe(WATCHED.length + 1)
  expect(fake.calls.filter((c) => c.path === '/v1/sessions')).toHaveLength(1)
  reset(fake)
  await host.seats()
  expect(fake.calls).toHaveLength(0)
})

test('idle reads issue zero HRC reads across minutes of wall-clock age', async () => {
  const { fake, host } = await following()
  const original = Date.now
  try {
    const now = original()
    Date.now = () => now + 600_000
    for (let i = 0; i < 5; i++) await host.seats()
    expect(fake.calls).toHaveLength(0)
  } finally {
    Date.now = original
  }
})

test('a c2 row discovers an unscoped new seat and deleting the last row removes it', async () => {
  const { fake, host } = await following()
  const scopeRef = 'agent:other:project:discovery:task:primary'
  fake.seats.set(scopeRef, { ...fake.seats.get(VESTA)!, scopeRef, hostSessionId: 'new-seat' })
  fake.put({ scopeRef, kind: 'probe', id: 'discovery', body: { v: 1 } })
  await delivered()
  expect((await host.annotations()).some((r) => r.scopeRef === scopeRef)).toBe(true)
  await host.delete({
    sessionRef: `${scopeRef}/lane:main`,
    subject: 'generation',
    generation: fake.seats.get(scopeRef)!.generation,
    ns: 'c2',
    kind: 'probe',
    id: 'discovery',
  })
  await delivered()
  await host.seats()
  reset(fake)
  await host.seats()
  expect((await host.seats()).some((s) => s.scopeRef === scopeRef)).toBe(false)
  expect(fake.calls).toHaveLength(0)
})

test('runtimeEnd caches confirmed generations and invalidates negative results on runtime events', async () => {
  const { fake, host } = await following()
  const seat = fake.seats.get(WATCHED[0]!)!
  const ref = `${seat.scopeRef}/lane:main`
  expect(await host.runtimeEnd!(ref, seat.generation)).toBeNull()
  expect(await host.runtimeEnd!(ref, seat.generation)).toBeNull()
  expect(fake.calls.filter((c) => c.path === '/v1/runtimes')).toHaveLength(1)
  fake.runtimes.push({
    runtimeId: 'ended',
    scopeRef: seat.scopeRef,
    laneRef: 'main',
    hostSessionId: seat.hostSessionId,
    generation: seat.generation,
    status: 'terminated',
    createdAt: 'now',
    updatedAt: 'now',
    runtimeStateJson: { terminationReason: 'user_initiated_session_end' },
  })
  fake.touch(seat.scopeRef, 'runtime.state')
  await delivered()
  expect(await host.runtimeEnd!(ref, seat.generation)).toMatchObject({ runtimeId: 'ended' })
  reset(fake)
  fake.touch(seat.scopeRef, 'runtime.state')
  await delivered()
  for (let i = 0; i < 5; i++)
    expect(await host.runtimeEnd!(ref, seat.generation)).toMatchObject({ runtimeId: 'ended' })
  expect(fake.calls.filter((c) => c.path === '/v1/runtimes')).toHaveLength(0)
})

test('preflight freshness: freshen and writes re-read the touched seats, joining no earlier pass', async () => {
  const { fake, host } = await following()
  const x = WATCHED[2]!
  // An unevented change, then the action's freshen: the next read sees it.
  fake.seats.get(x)!.runtimeLive = false
  host.freshen([x, VESTA])
  const seats = await host.seats()
  expect(new Set(readsBySeat(fake).keys())).toEqual(new Set([x, VESTA]))
  expect(seats.find((s) => s.scopeRef === x)?.status).toBe('inactive')

  // A write marks its seat: a read that started before it is not reused after it.
  reset(fake)
  fake.readDelayMs = 40
  fake.touch(WATCHED[4]!)
  await delivered()
  const before = host.seats()
  await Bun.sleep(5)
  fake.seats.get(x)!.runtimeLive = true
  await host.put(
    { sessionRef: `${x}/lane:main`, subject: 'seat', ns: 'c2', kind: 'probe', id: 'p1' },
    { v: 1 },
    { updatedAt: null },
    'agent:lance'
  )
  const after = await host.seats()
  await before
  expect(after.find((s) => s.scopeRef === x)?.status).toBe('active')
  expect((await host.annotations()).some((row) => row.kind === 'probe')).toBe(true)
})

test('new and archived continuity membership is event driven, without listing sessions', async () => {
  const { fake, host } = await following()
  const scopeRef = 'agent:mable:project:dirty:task:seat-99'
  fake.seats.set(scopeRef, { ...fake.seats.get(VESTA)!, scopeRef, hostSessionId: 'born' })
  fake.touch(scopeRef, 'session.created')
  await delivered()
  expect((await host.seats()).some((s) => s.scopeRef === scopeRef)).toBe(true)
  fake.put({ scopeRef, kind: 'probe', id: 'archive', body: { v: 1 } })
  await delivered()
  await host.seats()
  reset(fake)
  fake.touch(scopeRef, 'session.archived')
  await delivered()
  expect((await host.seats()).some((s) => s.scopeRef === scopeRef)).toBe(false)
  expect(fake.calls.filter((c) => c.path === '/v1/sessions')).toHaveLength(0)
})

test.each(['gap', 'ledger_replaced'] as const)(
  '%s triggers one bounded resync then idle reads stop',
  async (type) => {
    const { fake, host } = await following()
    if (type === 'ledger_replaced') fake.events.incarnation = 'new-ledger'
    fake.events.control(
      type === 'gap'
        ? {
            type,
            ledgerIncarnationId: 'fake-ledger',
            reason: 'live_queue',
            afterHrcSeq: 0,
            beforeHrcSeq: 1,
            dropped: 1,
          }
        : {
            type,
            expectedLedgerIncarnationId: 'fake-ledger',
            currentLedgerIncarnationId: 'new-ledger',
          }
    )
    await until('recovery', () => logs.filter((l) => l.includes('follow.connected')).length === 2)
    reset(fake)
    await host.seats()
    expect(fake.calls.filter((c) => c.path === '/v1/sessions')).toHaveLength(1)
    expect(readsBySeat(fake).size).toBe(WATCHED.length + 1)
    reset(fake)
    for (let i = 0; i < 5; i++) await host.seats()
    expect(fake.calls).toHaveLength(0)
  }
)
