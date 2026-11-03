import { expect, test } from 'bun:test'

import { HrcClient } from 'hrc-sdk'

import { createC2HrcHost } from '../../src/c2/hrc-adapter.js'
import { VESTA, fixtureSeats } from './c2-acp.js'
import { startFakeHrc } from './fake-hrc.js'

test('a fresh C2 observation reads annotations once per watched seat and bounds fanout', async () => {
  const watched = Array.from({ length: 24 }, (_, i) => `agent:mable:project:load:task:seat-${i}`)
  const template = fixtureSeats().find((seat) => seat.scopeRef === VESTA)!
  const fake = startFakeHrc([
    template,
    ...watched.map((scopeRef, i) => ({ ...template, scopeRef, hostSessionId: `hs-load-${i}` })),
  ])
  // No event follower: every read is a full read, whose cost and fanout this measures.
  fake.events.enabled = false
  let closeHost = () => {}
  try {
    fake.put({
      scopeRef: VESTA,
      subject: 'seat',
      kind: 'config',
      id: 'scope',
      body: { v: 1, allow: ['^agent:mable:project:load:task:seat-[0-9]+$'] },
    })
    const seat = watched[0]!
    fake.put({
      scopeRef: seat,
      subject: 'seat',
      ns: 'hrc',
      kind: 'asks',
      id: 'open',
      body: { v: 1, questions: [] },
    })
    fake.put({ scopeRef: seat, ns: 'other', kind: 'private', id: 'hidden', body: {} })
    fake.put({ scopeRef: seat, ns: 'hrc', kind: 'other', id: 'hidden', body: {} })
    fake.put({ scopeRef: seat, ns: 'hrc', kind: 'asks', id: 'generation-hidden', body: {} })
    const host = createC2HrcHost({
      client: new HrcClient({ socketPath: fake.socketPath }),
      vestaSeat: VESTA,
      principal: 'system:c2-controller',
      node: 'max3',
      sweepMs: 60_000,
      fullRefreshMs: 30_000,
      ownsUnscoped: true,
      literalInputTimeoutMs: 1000,
      log() {},
    })
    closeHost = host.close
    // Warm the continuity sweep; measure the next fresh observation independently.
    await Promise.all([host.seats(), host.annotations()])
    fake.calls.length = 0
    fake.readDelayMs = 30
    let peak = 0
    const probe = setInterval(() => {
      peak = Math.max(
        peak,
        [...fake.inflight.now.values()].reduce((a, b) => a + b, 0)
      )
    }, 2)
    let rows: Awaited<ReturnType<typeof host.annotations>>
    try {
      const [seats, annotations] = await Promise.all([host.seats(), host.annotations()])
      rows = annotations
      expect(seats).toHaveLength(watched.length + 1)
    } finally {
      clearInterval(probe)
    }
    const lists = fake.calls.filter((call) => call.path === '/v1/sessions/annotations')
    for (const scopeRef of [VESTA, ...watched]) {
      expect(lists.filter((call) => call.query['scopeRef'] === scopeRef)).toHaveLength(1)
    }
    expect(peak).toBeGreaterThan(1)
    expect(peak).toBeLessThanOrEqual(16)
    expect(rows.filter((row) => row.scopeRef === seat).map((row) => row.id)).toEqual(['open'])

    // Completed observations are never cached: an external scope change is
    // visible to the very next read used by action preflight.
    fake.put({
      scopeRef: VESTA,
      subject: 'seat',
      kind: 'config',
      id: 'scope',
      body: { v: 1, allow: [] },
    })
    // The asks-bearing seat stays observed for its existing row lifecycle.
    expect((await host.seats()).map((row) => row.scopeRef)).toEqual([VESTA, seat])
  } finally {
    closeHost()
    await fake.stop()
  }
})
