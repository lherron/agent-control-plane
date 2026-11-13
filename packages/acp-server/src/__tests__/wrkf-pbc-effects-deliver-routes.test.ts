import { describe, expect, test } from 'bun:test'

import { TASK, WrkfError, makeFakePbcPort } from '../../test/fixtures/pbc-route-port.js'
import { withWiredServer } from '../../test/fixtures/wired-server.js'

describe('PBC effects-deliver HTTP contract', () => {
  test('calls effect.deliver for each pending effect by effectId', async () => {
    const wrkf = makeFakePbcPort()

    await withWiredServer(
      async (fixture) => {
        await fixture.request({
          method: 'POST',
          path: '/v1/wrkf/effects/deliver',
          body: { task: TASK },
        })

        const deliverCalls = wrkf._calls.filter((c) => c.method === 'effect.deliver')
        // CANNED_EFFECTS has 2 pending effects; both should be delivered
        expect(deliverCalls.length).toBeGreaterThanOrEqual(2)

        // Each deliver call must have effectId matching the listed effects
        const effectIds = deliverCalls.map((c) => (c.params as Record<string, unknown>)['effectId'])
        expect(effectIds).toContain('eff-aaa')
        expect(effectIds).toContain('eff-bbb')
      },
      { wrkf }
    )
  })

  test('delivered effectIds match the ids returned by effect.list', async () => {
    // The route must only deliver effects that effect.list reports as pending.
    const specificEffects = [
      { id: 'eff-xyz-1', kind: 'set_task_state', status: 'pending' },
      { id: 'eff-xyz-2', kind: 'set_task_state', status: 'delivered' }, // not pending → skip
    ]
    const wrkf = makeFakePbcPort({
      effectList: async () => specificEffects,
    })

    await withWiredServer(
      async (fixture) => {
        await fixture.request({
          method: 'POST',
          path: '/v1/wrkf/effects/deliver',
          body: { task: TASK },
        })

        const deliverCalls = wrkf._calls.filter((c) => c.method === 'effect.deliver')
        const deliveredIds = deliverCalls.map(
          (c) => (c.params as Record<string, unknown>)['effectId']
        )

        // Only pending effects should be delivered
        expect(deliveredIds).toContain('eff-xyz-1')
        expect(deliveredIds).not.toContain('eff-xyz-2') // already delivered → skip
      },
      { wrkf }
    )
  })

  test('WRKF_LEASE_CONFLICT on deliver is skipped (not fatal)', async () => {
    // Per SPEC §4.16: WRKF_LEASE_CONFLICT → skip effect and re-list; not fatal
    let deliverCount = 0
    const wrkf = makeFakePbcPort({
      effectDeliver: async () => {
        deliverCount++
        if (deliverCount === 1) {
          throw new WrkfError('WRKF_LEASE_CONFLICT', 'effect leased by another worker')
        }
        return { status: 'delivered' }
      },
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: '/v1/wrkf/effects/deliver',
          body: { task: TASK },
        })

        // LEASE_CONFLICT must not cause 409 on the route; route still returns 200
        expect(response.status).toBe(200)
        const body = await fixture.json<{ delivered: string[]; skipped: unknown[] }>(response)
        // The conflicted effect should appear in skipped, not delivered
        expect(body.skipped.length).toBeGreaterThan(0)
      },
      { wrkf }
    )
  })
})
