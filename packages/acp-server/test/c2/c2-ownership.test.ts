/**
 * Which seats an instance owns (T-12207, the one-controller rule): the
 * instance serving the production Vesta also observes every seat holding c2
 * rows, so its prune reaches legacy rows outside the scope (card contract rev 4 §3). An instance
 * configured with any other Vesta (the 18471 fixture) observes only its Vesta
 * and the seats its scope row allows, so it never touches a real human card.
 */
import { expect, test } from 'bun:test'

import {
  FIXTURE_VESTA,
  OUT_SEAT,
  SEAT,
  type Snapshot,
  VESTA,
  settle,
  snapshotEntry,
  withC2Acp,
} from './c2-acp.js'

function touched(
  calls: Array<{ method: string; path: string; query: Record<string, string>; body: unknown }>,
  scopeRef: string
) {
  return calls.filter(
    (call) =>
      call.path.startsWith('/v1/sessions/') &&
      (call.query['scopeRef'] === scopeRef ||
        (call.body as { scopeRef?: string } | undefined)?.scopeRef === scopeRef)
  )
}

test('the production-Vesta instance observes seats holding c2 rows outside its scope', async () => {
  await withC2Acp(async (acp) => {
    await snapshotEntry(acp)
    await settle()
    expect(touched(acp.fake.calls, OUT_SEAT).length).toBeGreaterThan(0)
    // Discovered by the sweep's listing, but another Vesta's seat is never observed.
    expect(
      touched(acp.fake.calls, FIXTURE_VESTA).filter(
        (call) => call.path === '/v1/sessions/attention'
      )
    ).toHaveLength(0)
  })
})

test('a non-production-Vesta instance never reads or writes a seat outside its scope', async () => {
  await withC2Acp(
    async (acp) => {
      const { snapshot, entry } = await snapshotEntry(acp)
      expect(entry.seat.scopeRef).toBe(SEAT)
      expect((snapshot as Snapshot).vesta).toMatchObject({
        online: true,
        sessionRef: `${FIXTURE_VESTA}/lane:main`,
      })
      await settle(600)
      // No sweep scan, observation, write or act ever names a seat outside its scope.
      expect(touched(acp.fake.calls, OUT_SEAT)).toHaveLength(0)
      expect(touched(acp.fake.calls, VESTA)).toHaveLength(0)
    },
    { fixtureVesta: true }
  )
})
