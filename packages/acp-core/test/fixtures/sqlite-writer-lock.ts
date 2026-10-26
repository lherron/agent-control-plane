import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Opens a store on a fresh DB while another process holds SQLite's exclusive
 * writer lock for `holdMs`. A store that sets busy_timeout before its first
 * locking pragma waits the lock out; one that doesn't throws SQLITE_BUSY at
 * once (T-11922).
 */
export async function openUnderForeignWriterLock(
  open: (dbPath: string) => { close(): void },
  holdMs = 400
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'sqlite-writer-lock-'))
  const dbPath = join(dir, 'store.db')
  const holder = Bun.spawn({
    cmd: [
      process.execPath,
      '-e',
      `const { Database } = require('bun:sqlite')
       const db = new Database(${JSON.stringify(dbPath)})
       db.exec('CREATE TABLE IF NOT EXISTS writer_lock_holder (id INTEGER)')
       db.exec('BEGIN EXCLUSIVE')
       db.exec('INSERT INTO writer_lock_holder VALUES (1)')
       console.log('locked')
       setTimeout(() => { db.exec('COMMIT'); db.close() }, ${holdMs})`,
    ],
    stdout: 'pipe',
    stderr: 'inherit',
  })
  try {
    const { value } = await holder.stdout.getReader().read()
    if (!new TextDecoder().decode(value).includes('locked')) {
      throw new Error('writer lock holder did not report the lock')
    }
    open(dbPath).close()
  } finally {
    await holder.exited
    rmSync(dir, { recursive: true, force: true })
  }
}
