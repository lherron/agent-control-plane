/**
 * T-12421 amendment (b): an HRC event for a watched seat starts a read now,
 * rate-limited to one per pollMs with a trailing read; the poll timer is only
 * the fallback.
 *
 * Ways this can fail: the change waits for the poll tick anyway; a burst of
 * events starts a read per event; the last event of a burst is dropped
 * (no trailing read); an event for an unwatched seat starts reads.
 */
import { expect, test } from 'bun:test'

import {
  SEAT,
  SNAPSHOT,
  type Snapshot,
  asksBody,
  settle,
  snapshotEntry,
  withC2Acp,
} from './c2-acp.js'

/** Wait for the follower and the full read its connect owes, then a quiet baseline. */
async function warm(acp: Parameters<Parameters<typeof withC2Acp>[0]>[0]) {
  const { snapshot } = await snapshotEntry(acp)
  const deadline = Date.now() + 5000
  while (acp.fake.events.followers() < 1) {
    if (Date.now() > deadline) throw new Error('no follower')
    await Bun.sleep(10)
  }
  await settle(300)
  return snapshot
}

const seatReads = (acp: Parameters<Parameters<typeof withC2Acp>[0]>[0]) =>
  acp.fake.calls.filter(
    (call) => call.path === '/v1/sessions/attention' && call.query['scopeRef'] === SEAT
  ).length

test('an asks change reaches the snapshot without waiting for a slow poll', async () => {
  await withC2Acp(
    async (acp) => {
      const before = await warm(acp)
      const started = Date.now()
      const pending = acp.getJson<Snapshot>(
        `${SNAPSHOT}?after=${encodeURIComponent(before.revision)}&waitMs=8000`
      )
      acp.fake.put({
        scopeRef: SEAT,
        subject: 'seat',
        ns: 'hrc',
        kind: 'asks',
        id: 'open',
        body: asksBody({ ask: 'Evented?' }),
        by: 'agent:smokey',
      })
      const { body } = await pending
      expect(body.entries.find((e) => e.seat.scopeRef === SEAT)?.rows[0]?.ask).toBe('Evented?')
      // The fallback poll is 10 s; the event read lands in well under one.
      expect(Date.now() - started).toBeLessThan(1000)
    },
    { config: { pollMs: 10_000 } }
  )
}, 30_000)

test('a burst of events reads at most once per pollMs, and the trailing read sees the last one', async () => {
  await withC2Acp(
    async (acp) => {
      await warm(acp)
      const reads0 = seatReads(acp)
      const seat = acp.fake.seats.get(SEAT)!
      for (let i = 0; i < 20; i += 1) {
        seat.attention = { ...seat.attention!, excerpt: `burst ${i}` }
        acp.fake.touch(SEAT, 'turn.message')
        await Bun.sleep(20)
      }
      // ~400 ms of events inside one 1 s window: one leading read, one trailing.
      await settle(1500)
      const reads = seatReads(acp) - reads0
      expect(reads).toBeGreaterThanOrEqual(1)
      expect(reads).toBeLessThanOrEqual(3)
      const { body } = await acp.getJson<Snapshot>(SNAPSHOT)
      expect(body.entries.find((e) => e.seat.scopeRef === SEAT)?.attention?.excerpt).toBe(
        'burst 19'
      )
    },
    { config: { pollMs: 1000 } }
  )
}, 30_000)

test('an event for an unwatched seat starts no read', async () => {
  await withC2Acp(
    async (acp) => {
      await warm(acp)
      const calls0 = acp.fake.calls.length
      // A seat no scope allows and holding no c2 rows.
      acp.fake.seats.set('agent:nobody:project:x:task:primary', {
        ...acp.fake.seats.get(SEAT)!,
        scopeRef: 'agent:nobody:project:x:task:primary',
        hostSessionId: 'hs-nobody',
      })
      for (let i = 0; i < 5; i += 1) acp.fake.touch('agent:nobody:project:x:task:primary')
      await settle(500)
      const reads = acp.fake.calls
        .slice(calls0)
        .filter((call) => call.path.startsWith('/v1/sessions/'))
      expect(reads).toEqual([])
    },
    { config: { pollMs: 10_000 } }
  )
}, 30_000)
