import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { openInterfaceStore } from 'acp-interface-store'
import { InMemoryRunStore } from '../src/domain/run-store.js'
import { createInterfaceRunDispatcher } from '../src/integration/interface-run-dispatcher.js'
import { StoreCommitBus } from '../src/store-commit-bus.js'
import { createHrcRouteFake } from './fixtures/hrc-route-fake.js'

test('real idle interface dispatcher scans only at startup until a commit', async () => {
  const bus = new StoreCommitBus()
  const runStore = new InMemoryRunStore()
  const interfaceStore = openInterfaceStore({ dbPath: ':memory:' })
  const original = runStore.listRunsByStatus.bind(runStore)
  let scans = 0
  runStore.listRunsByStatus = (status) => {
    if (status === 'pending') scans++
    return original(status)
  }
  const dispatcher = createInterfaceRunDispatcher({
    commitBus: bus,
    runStore,
    interfaceStore,
    hrc: createHrcRouteFake(new Database(':memory:')),
    config: { intervalMs: 20, staleTimeoutMs: 10000 },
  })
  try {
    dispatcher.start()
    await Bun.sleep(75)
    expect(scans).toBe(1)
    const start = performance.now()
    bus.notify('runs')
    await Bun.sleep(25)
    expect(scans).toBe(2)
    expect(performance.now() - start).toBeLessThan(100)
  } finally {
    await dispatcher.stop()
    interfaceStore.close()
  }
})
