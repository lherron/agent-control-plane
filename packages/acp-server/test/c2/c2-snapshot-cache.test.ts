/**
 * T-12227: a phone GET never waits on a full HRC observation once a snapshot
 * exists. On a loaded HRC (per-read latency in seconds), `GET /v2/snapshot` serves
 * the warm snapshot the host refreshes in the background; only a cold start
 * waits for the first read. The long poll still wakes on a change any
 * background refresh sees.
 */
import { expect, test } from 'bun:test'

import { SEAT, type Snapshot, VESTA, asksBody, settle, snapshotEntry, withC2Acp } from './c2-acp.js'

const SLOW_READ_MS = 1500

test('on a slow HRC, 20 concurrent warm GETs return from cache with one observation in flight', async () => {
  await withC2Acp(
    async (acp) => {
      const { snapshot } = await snapshotEntry(acp)
      acp.fake.readDelayMs = SLOW_READ_MS
      // Let a slow background observation get going.
      await settle(200)
      const vestaReadsBefore = acp.fake.calls.filter(
        (call) => call.query['scopeRef'] === VESTA
      ).length

      const timed = await Promise.all(
        Array.from({ length: 20 }, async () => {
          const started = performance.now()
          const result = await acp.getJson<Snapshot>('/v1/mobile/c2/v2/snapshot')
          return { ...result, ms: performance.now() - started }
        })
      )
      for (const { status, body, ms } of timed) {
        expect(status).toBe(200)
        expect(ms).toBeLessThan(200)
        expect(body.revision).toBe(snapshot.revision)
        expect(body.home).toMatchObject({ reachable: true, stale: false })
        expect(body.entries.find((e) => e.seat.scopeRef === SEAT)).toBeDefined()
      }
      // The burst started no observation of its own: one observation reads Vesta
      // four times (scope rows, then attention, c2 rows and the asks record together).
      const vestaReads = acp.fake.calls.filter((call) => call.query['scopeRef'] === VESTA)
      expect(vestaReads.length - vestaReadsBefore).toBeLessThanOrEqual(4)
      expect(acp.fake.inflight.max.get(VESTA) ?? 0).toBeLessThanOrEqual(3)
    },
    { config: { pollMs: 50 } }
  )
}, 30_000)

test('on a slow HRC, a changed asks record reaches the snapshot and wakes a long poll', async () => {
  await withC2Acp(
    async (acp) => {
      const { snapshot } = await snapshotEntry(acp)
      acp.fake.readDelayMs = SLOW_READ_MS
      const started = Date.now()
      const pending = acp.getJson<Snapshot>(
        `/v1/mobile/c2/v2/snapshot?after=${encodeURIComponent(snapshot.revision)}&waitMs=20000`
      )
      acp.fake.put({
        scopeRef: SEAT,
        subject: 'seat',
        ns: 'hrc',
        kind: 'asks',
        id: 'open',
        body: asksBody({ ask: 'Ship it under load?' }),
        by: 'agent:smokey',
      })
      const { status, body } = await pending
      expect(status).toBe(200)
      expect(body.unchanged).toBeUndefined()
      expect(body.revision).not.toBe(snapshot.revision)
      expect(body.entries.find((e) => e.seat.scopeRef === SEAT)?.rows[0]?.ask).toBe(
        'Ship it under load?'
      )
      // Within a couple of slow observations, not the long poll's deadline.
      expect(Date.now() - started).toBeLessThan(12_000)

      // A plain GET now serves the new snapshot from cache, immediately.
      const t0 = performance.now()
      const after = await acp.getJson<Snapshot>('/v1/mobile/c2/v2/snapshot')
      expect(performance.now() - t0).toBeLessThan(200)
      expect(after.body.revision).toBe(body.revision)
      expect(Date.parse(after.body.asOf)).toBeGreaterThan(Date.parse(snapshot.asOf))
    },
    { config: { pollMs: 50 } }
  )
}, 30_000)

test('a cold start on a slow HRC waits for the first read and returns the snapshot', async () => {
  await withC2Acp(
    async (acp) => {
      const started = Date.now()
      const { snapshot } = await snapshotEntry(acp)
      expect(snapshot.home).toMatchObject({ reachable: true, stale: false })
      expect(Date.now() - started).toBeLessThan(10_000)
    },
    {
      beforeBoot: (fake) => {
        fake.readDelayMs = 300
      },
    }
  )
}, 30_000)
