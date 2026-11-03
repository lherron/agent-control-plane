/**
 * T-12421: seat reads are dirty-driven off one HRC event follow stream.
 *
 * Ways this can fail, each pinned below:
 *  - an idle watched seat is still re-read every poll (the load this fixes);
 *  - an event for one seat re-reads every seat, or not that seat;
 *  - an annotation change (asks put/delete) never reaches the snapshot;
 *  - a dropped or refused stream leaves reads serving a frozen cache;
 *  - no event ever comes for a change, and nothing bounds the staleness;
 *  - the safety net is one long pass that a dirty seat's read queues behind;
 *  - an action's preflight is served from the cache instead of HRC.
 */
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

function boot(fullRefreshMs = 60_000): { fake: FakeHrc; host: C2HrcHost } {
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
    sweepMs: 60_000,
    fullRefreshMs,
    ownsUnscoped: false,
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
async function following(fullRefreshMs?: number) {
  const booted = boot(fullRefreshMs)
  await booted.host.seats()
  await until('the follower', () => booted.fake.events.followers() === 1)
  await booted.host.seats()
  reset(booted.fake)
  return booted
}

/** Let an event cross the follow stream. */
const delivered = () => Bun.sleep(50)

test('idle watched seats are not re-read between full refreshes', async () => {
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

test('a dropped follower falls back to full reads, then resumes dirty-driven reads', async () => {
  const { fake, host } = await following()
  fake.touch(WATCHED[5]!)
  await delivered()
  const seen = fake.ledger.at(-1)!.hrcSeq
  fake.events.enabled = false
  fake.events.drop()
  await until('the follower to go down', () => logs.some((l) => l.startsWith('c2.follow.down')))
  for (let i = 0; i < 2; i += 1) {
    reset(fake)
    await host.seats()
    const reads = readsBySeat(fake)
    for (const scopeRef of [VESTA, ...WATCHED]) expect(reads.get(scopeRef)).toBe(2)
  }
  // Back: it reconnects from the last seen hrcSeq, reads everything once, then only dirty seats.
  fake.events.enabled = true
  await until('the follower to reconnect', () => fake.events.followers() === 1)
  reset(fake)
  await host.seats()
  expect(readsBySeat(fake).size).toBe(WATCHED.length + 1)
  reset(fake)
  await host.seats()
  expect(readsBySeat(fake).size).toBe(0)
  const reconnect = logs.filter((l) => l.startsWith('c2.follow.connected'))
  expect(reconnect).toHaveLength(2)
  expect(reconnect[1]).toBe(`c2.follow.connected fromSeq=${seen + 1}`)
})

test('the rolling safety net re-reads every watched seat with no event, a few per read', async () => {
  const { fake, host } = await following(200)
  await host.seats()
  expect(readsBySeat(fake).size).toBe(0)
  await Bun.sleep(220)
  const x = WATCHED[0]!
  // A change HRC never evented still lands within the safety net's bound.
  fake.seats.get(x)!.runtimeLive = false
  const reread = new Set<string>()
  let seats = await host.seats()
  for (let pass = 0; pass < 2; pass += 1) {
    const reads = readsBySeat(fake)
    // Never one long pass a dirty read would queue behind: Vesta plus at most four aged seats.
    expect([...reads.keys()].filter((s) => s !== VESTA).length).toBeLessThanOrEqual(4)
    for (const scopeRef of reads.keys()) reread.add(scopeRef)
    reset(fake)
    if (pass === 0) seats = await host.seats()
  }
  expect(reread).toEqual(new Set([VESTA, ...WATCHED]))
  expect((await host.seats()).find((s) => s.scopeRef === x)?.status).toBe('inactive')
  expect(seats).toBeDefined()
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
