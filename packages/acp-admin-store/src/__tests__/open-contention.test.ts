import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openSqliteAdminStore } from '../open-store.js'

const tmpDirs: string[] = []

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

// Another process briefly holding the write lock must make open wait, not fail
// SQLITE_BUSY: busy_timeout has to be set before the first locking pragma (T-11922).
test('open waits out a writer lock held by another process', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'acp-admin-open-'))
  tmpDirs.push(dir)
  const dbPath = join(dir, 'acp-admin.db')

  const holder = Bun.spawn({
    cmd: [
      process.execPath,
      '-e',
      `const { Database } = require('bun:sqlite')
       const db = new Database(${JSON.stringify(dbPath)})
       db.exec('CREATE TABLE IF NOT EXISTS hold (id INTEGER)')
       db.exec('BEGIN EXCLUSIVE')
       db.exec('INSERT INTO hold VALUES (1)')
       console.log('locked')
       setTimeout(() => { db.exec('COMMIT'); db.close() }, 400)`,
    ],
    stdout: 'pipe',
    stderr: 'inherit',
  })
  const reader = holder.stdout.getReader()
  const { value } = await reader.read()
  expect(new TextDecoder().decode(value)).toContain('locked')

  const store = openSqliteAdminStore({ dbPath })
  try {
    expect(store.agents.list()).toEqual([])
  } finally {
    store.close()
    await holder.exited
  }
})
