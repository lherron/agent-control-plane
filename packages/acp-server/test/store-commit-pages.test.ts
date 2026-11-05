import { expect, test } from 'bun:test'
import { StoreCommitBus } from '../src/store-commit-bus.js'
import { withWiredServer } from './fixtures/wired-server.js'

test('delivery timeout reads once; a commit wakes and re-reads once', async () => {
  const bus = new StoreCommitBus()
  await withWiredServer(
    async (fixture) => {
      const original = fixture.interfaceStore.deliveries.listQueuedForGateway.bind(
        fixture.interfaceStore.deliveries
      )
      let reads = 0
      fixture.interfaceStore.deliveries.listQueuedForGateway = (id) => {
        reads++
        return original(id)
      }
      let start = performance.now()
      const response = await fixture.request({
        method: 'GET',
        path: '/v1/gateway/discord/deliveries/stream?waitMs=40',
      })
      expect(response.status).toBe(200)
      expect(performance.now() - start).toBeGreaterThanOrEqual(30)
      expect(reads).toBe(1)
      reads = 0
      start = performance.now()
      const waiting = fixture.request({
        method: 'GET',
        path: '/v1/gateway/discord/deliveries/stream?waitMs=60000',
      })
      await Bun.sleep(10)
      bus.notify('deliveries')
      await waiting
      expect(performance.now() - start).toBeLessThan(100)
      expect(reads).toBe(2)
    },
    { commitBus: bus }
  )
})

test('waitMs rejects values outside the integer range', async () => {
  await withWiredServer(
    async (fixture) => {
      for (const value of ['60001', '-1', 'abc', '0.5']) {
        const response = await fixture.request({
          method: 'GET',
          path: `/v1/gateway/discord/deliveries/stream?waitMs=${value}`,
        })
        expect(response.status).toBe(400)
      }
    },
    { commitBus: new StoreCommitBus() }
  )
})

import { openSqliteAdminStore } from 'acp-admin-store'

test('system-events timeout reads once and a real committed append wakes the page', async () => {
  const bus = new StoreCommitBus()
  const adminStore = openSqliteAdminStore({
    dbPath: ':memory:',
    onCommit: () => bus.notify('system-events'),
  })
  let reads = 0
  const original = adminStore.systemEvents.list.bind(adminStore.systemEvents)
  adminStore.systemEvents.list = (input) => {
    reads++
    return original(input)
  }
  try {
    await withWiredServer(
      async (fixture) => {
        await fixture.request({
          method: 'GET',
          path: '/v1/admin/system-events?afterEventId=0&waitMs=20',
        })
        expect(reads).toBe(1)
        const waiting = fixture.request({
          method: 'GET',
          path: '/v1/admin/system-events?afterEventId=0&waitMs=60000',
        })
        await Bun.sleep(10)
        const start = performance.now()
        adminStore.systemEvents.append({
          projectId: 'agent-control-plane',
          kind: 'bus.test',
          occurredAt: new Date().toISOString(),
          recordedAt: new Date().toISOString(),
          payload: {},
        })
        const response = await waiting
        expect((await response.json()).events).toHaveLength(1)
        expect(performance.now() - start).toBeLessThan(100)
        expect(reads).toBe(3)
      },
      { commitBus: bus, adminStore }
    )
  } finally {
    adminStore.close()
  }
})
