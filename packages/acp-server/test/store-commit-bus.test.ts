import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { observeSqliteCommits } from '../../acp-core/src/sqlite-commits.js'
import { StoreCommitBus } from '../src/store-commit-bus.js'

test('version taken before scan prevents a lost wake and wakes in under 100ms', async () => {
  const bus = new StoreCommitBus()
  const version = bus.version('runs')
  bus.notify('runs') // commit while scan is in progress
  const start = performance.now()
  await bus.wait('runs', version, { timeoutMs: 60000 })
  expect(performance.now() - start).toBeLessThan(100)
})

test('idle waits do not rescan, deadline and abort release waiters', async () => {
  const bus = new StoreCommitBus()
  let scans = 1
  const controller = new AbortController()
  const waiting = bus
    .wait('runs', 0, { timeoutMs: 60000, signal: controller.signal })
    .then(() => scans++)
  await Bun.sleep(30)
  expect(scans).toBe(1)
  controller.abort()
  await waiting
  expect(scans).toBe(2)
  const start = performance.now()
  await bus.wait('jobs', 0, { timeoutMs: 20 })
  expect(performance.now() - start).toBeGreaterThanOrEqual(15)
})

test('only committed changed writes notify, once after outer commit', () => {
  const raw = new Database(':memory:')
  raw.exec('CREATE TABLE items (id INTEGER PRIMARY KEY)')
  let notifications = 0
  const db = observeSqliteCommits(raw, () => {
    expect(raw.inTransaction).toBe(false)
    notifications++
  })
  const insert = db.prepare('INSERT INTO items VALUES (?)')
  db.transaction(() => {
    insert.run(1)
    db.transaction(() => insert.run(2))()
    expect(notifications).toBe(0)
  })()
  expect(notifications).toBe(1)
  expect(() =>
    db.transaction(() => {
      insert.run(3)
      throw Error('rollback')
    })()
  ).toThrow()
  expect(notifications).toBe(1)
  db.prepare('DELETE FROM items WHERE id = 999').run()
  db.prepare('SELECT * FROM items').all()
  expect(notifications).toBe(1)
  db.prepare('INSERT INTO items VALUES (4) RETURNING *').get()
  expect(notifications).toBe(2)
  raw.close()
})

import { createStoreScanLoop } from '../src/integration/store-scan-loop.js'

test('idle scan parks; external completion cadence and deadlines remain active', async () => {
  const bus = new StoreCommitBus()
  let scans = 0
  let external = false
  const loop = createStoreScanLoop({
    name: 'test',
    bus,
    topics: ['runs'],
    scan: async () => {
      scans++
    },
    nextDelayMs: () => (external ? 20 : 60000),
  })
  loop.start()
  await Bun.sleep(50)
  expect(scans).toBe(1)
  external = true
  bus.notify('runs')
  await Bun.sleep(55)
  expect(scans).toBeGreaterThanOrEqual(3)
  external = false
  await loop.stop()
})

test('commit during asynchronous scan causes immediate rescan', async () => {
  const bus = new StoreCommitBus()
  let scans = 0
  const loop = createStoreScanLoop({
    name: 'test',
    bus,
    topics: ['runs'],
    scan: async () => {
      scans++
      if (scans === 1) {
        await Bun.sleep(1)
        bus.notify('runs')
      }
    },
    nextDelayMs: () => 60000,
  })
  loop.start()
  await Bun.sleep(30)
  expect(scans).toBe(2)
  await loop.stop()
})

test('server shutdown releases parked pages without a version advance or reread', async () => {
  const bus = new StoreCommitBus()
  const pending = bus.wait('deliveries', 0, { timeoutMs: 60000 })
  bus.close()
  await pending
  expect(bus.version('deliveries')).toBe(0)
  await bus.wait('deliveries', 0, { timeoutMs: 60000 })
})

test('commit helper reports only changed tables, excluding rolled-back nested writes', () => {
  const raw = new Database(':memory:')
  raw.exec(
    'CREATE TABLE runs(id INTEGER PRIMARY KEY); CREATE TABLE mobile_timeline(id INTEGER PRIMARY KEY)'
  )
  const tables: string[][] = []
  const db = observeSqliteCommits(raw, (changed) => tables.push([...changed].sort()))
  db.transaction(() => {
    db.prepare('INSERT INTO runs VALUES (1)').run()
    try {
      db.transaction(() => {
        db.prepare('INSERT INTO mobile_timeline VALUES (1)').run()
        throw Error('rollback')
      })()
    } catch {}
  })()
  expect(tables).toEqual([['runs']])
  raw.close()
})
