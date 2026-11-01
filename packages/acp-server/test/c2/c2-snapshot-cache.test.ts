/**
 * T-12227: a phone GET never waits on a full HRC observation once a snapshot
 * exists. On a loaded HRC (per-read latency in seconds), `GET /cards` serves
 * the warm snapshot the host refreshes in the background; only a cold start
 * waits for the first read. The long poll still wakes on a change any
 * background refresh sees.
 */
import { expect, test } from 'bun:test'

import {
  ATTENTION_AT,
  SEAT,
  type Snapshot,
  VESTA,
  settle,
  snapshotCard,
  withC2Acp,
} from './c2-acp.js'

const SLOW_READ_MS = 1500

test('on a slow HRC, 20 concurrent warm GETs return from cache with one observation in flight', async () => {
  await withC2Acp(
    async (acp) => {
      const { snapshot } = await snapshotCard(acp)
      acp.fake.readDelayMs = SLOW_READ_MS
      // Let a slow background observation get going.
      await settle(200)
      const vestaReadsBefore = acp.fake.calls.filter(
        (call) => call.query['scopeRef'] === VESTA
      ).length

      const timed = await Promise.all(
        Array.from({ length: 20 }, async () => {
          const started = performance.now()
          const result = await acp.getJson<Snapshot>('/v1/mobile/c2/cards')
          return { ...result, ms: performance.now() - started }
        })
      )
      for (const { status, body, ms } of timed) {
        expect(status).toBe(200)
        expect(ms).toBeLessThan(200)
        expect(body.revision).toBe(snapshot.revision)
        expect(body.home).toMatchObject({ reachable: true, stale: false })
        expect(body.seats.find((seat) => seat.scopeRef === SEAT)?.card).not.toBeNull()
      }
      // The burst started no observation of its own: one observation reads Vesta
      // three times (scope rows, then attention and rows together).
      const vestaReads = acp.fake.calls.filter((call) => call.query['scopeRef'] === VESTA)
      expect(vestaReads.length - vestaReadsBefore).toBeLessThanOrEqual(3)
      expect(acp.fake.inflight.max.get(VESTA) ?? 0).toBeLessThanOrEqual(2)
    },
    { config: { pollMs: 50 } }
  )
}, 30_000)

test('on a slow HRC, a changed card reaches the snapshot and wakes a long poll', async () => {
  await withC2Acp(
    async (acp) => {
      const { snapshot } = await snapshotCard(acp)
      acp.fake.readDelayMs = SLOW_READ_MS
      const started = Date.now()
      const pending = acp.getJson<Snapshot>(
        `/v1/mobile/c2/cards?after=${encodeURIComponent(snapshot.revision)}&waitMs=20000`
      )
      acp.fake.put({
        scopeRef: SEAT,
        generation: 2,
        kind: 'card',
        id: ATTENTION_AT,
        body: { ...acp.card().body, title: 'Ship it under load?' },
      })
      const { status, body } = await pending
      expect(status).toBe(200)
      expect(body.unchanged).toBeUndefined()
      expect(body.revision).not.toBe(snapshot.revision)
      expect(body.seats.find((seat) => seat.scopeRef === SEAT)?.card?.title).toBe(
        'Ship it under load?'
      )
      // Within a couple of slow observations, not the long poll's deadline.
      expect(Date.now() - started).toBeLessThan(12_000)

      // A plain GET now serves the new snapshot from cache, immediately.
      const t0 = performance.now()
      const after = await acp.getJson<Snapshot>('/v1/mobile/c2/cards')
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
      const { snapshot } = await snapshotCard(acp)
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
