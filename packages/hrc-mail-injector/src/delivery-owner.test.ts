import { Database } from 'bun:sqlite'
import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DelivererLock, DeliveryOwner, InjectorOwnerLoop } from './delivery-owner.js'

const paths: string[] = []
afterEach(() => {
  for (const p of paths.splice(0)) rmSync(p, { recursive: true, force: true })
})
function statePath() {
  const p = mkdtempSync(join(tmpdir(), 'delivery-owner-'))
  paths.push(p)
  return join(p, 'injector.sqlite')
}

test('exclusive lock excludes contenders until release and close', () => {
  const path = statePath()
  const a = new DelivererLock(path)
  const b = new DelivererLock(path)
  try {
    expect(a.tryAcquire()).toBe(true)
    expect(b.tryAcquire()).toBe(false)
    a.release()
    expect(b.tryAcquire()).toBe(true)
    b.close()
    expect(a.tryAcquire()).toBe(true)
  } finally {
    a.close()
    b.close()
  }
})

test('owner defaults to injector; reporting does not grant authority', () => {
  const flag = new DeliveryOwner(statePath())
  try {
    expect(flag.read().owner).toBe('injector')
    flag.report('port', 42)
    expect(flag.read().owner).toBe('injector')
    flag.setOwner('port')
    expect(flag.read().delivering_pid).toBe(42)
    flag.clear()
    expect(flag.read().delivering_pid).toBe(null)
  } finally {
    flag.close()
  }
})

test('controller only starts under lock; stop finishes before release; repeat start anchors', async () => {
  const path = statePath()
  const flag = new DeliveryOwner(path)
  const lock = new DelivererLock(path)
  const other = new DelivererLock(path)
  const events: Array<{ event: string; detail: Record<string, unknown> }> = []
  let starts = 0
  let stops = 0
  const loop = new InjectorOwnerLoop(
    flag,
    lock,
    async () => {
      expect(other.tryAcquire()).toBe(false)
      starts++
      return {
        statePath: path,
        importMarker: { sourcePath: path, importedAt: '' },
        stop: async () => {
          expect(other.tryAcquire()).toBe(false)
          await Promise.resolve()
          stops++
        },
      }
    },
    (_level, event, detail) => events.push({ event, detail })
  )
  try {
    await loop.step()
    expect(starts).toBe(1)
    flag.setOwner('port')
    await loop.step()
    expect(stops).toBe(1)
    expect(other.tryAcquire()).toBe(true)
    flag.setOwner('injector')
    await loop.step()
    expect(starts).toBe(1)
    other.release()
    await loop.step()
    expect(starts).toBe(2)
    expect(events.filter((e) => e.event === 'mail_injector.started').length).toBe(2)
  } finally {
    await loop.stop()
    other.close()
    lock.close()
    flag.close()
  }
})

test('standby startup remains launchd compatible; stop forbids future starts', async () => {
  const path = statePath()
  const flag = new DeliveryOwner(path)
  const lock = new DelivererLock(path)
  flag.setOwner('port')
  const events: Record<string, unknown>[] = []
  const loop = new InjectorOwnerLoop(
    flag,
    lock,
    async () => {
      throw Error('must not start')
    },
    (_level, event, detail) => {
      if (event === 'mail_injector.started') events.push(detail)
    }
  )
  try {
    await loop.step()
    expect(events).toEqual([expect.objectContaining({ status: 'running', delivering: false })])
    await loop.stop()
    flag.setOwner('injector')
    await loop.step()
  } finally {
    lock.close()
    flag.close()
  }
})

test('reads create neither database nor table and retain last owner on busy', () => {
  const path = statePath()
  const flag = new DeliveryOwner(path)
  expect(flag.read().owner).toBe('injector')
  expect(existsSync(path)).toBe(false)
  const db = new Database(path, { create: true })
  try {
    db.exec('CREATE TABLE existing (id)')
    const before = readFileSync(path)
    expect(flag.read().owner).toBe('injector')
    expect(readFileSync(path)).toEqual(before)
    flag.setOwner('port')
    expect(flag.read().owner).toBe('port')
    db.exec('BEGIN EXCLUSIVE')
    expect(flag.read().owner).toBe('port')
    const cold = new DeliveryOwner(path)
    try {
      expect(cold.read().owner).toBe('injector')
    } finally {
      cold.close()
    }
    db.exec('ROLLBACK')
  } finally {
    db.close()
    flag.close()
  }
})
