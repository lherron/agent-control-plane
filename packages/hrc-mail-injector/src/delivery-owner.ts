/** Desired ownership is a preference; only the dedicated SQLite lock admits delivery. */
import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { StartedMailInjector } from './index.js'

// Keep byte-identical to Python delivery_owner.py; intentionally outside store migrations.
export const OWNER_SCHEMA = `CREATE TABLE IF NOT EXISTS delivery_owner (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  owner TEXT NOT NULL CHECK (owner IN ('injector', 'port')),
  changed_at TEXT NOT NULL,
  delivering_owner TEXT CHECK (delivering_owner IN ('injector', 'port')),
  delivering_pid INTEGER,
  delivering_since TEXT
)`
export type Owner = 'injector' | 'port'
type OwnerRow = {
  owner: Owner
  changed_at: string | null
  delivering_owner: Owner | null
  delivering_pid: number | null
  delivering_since: string | null
}
type Log = (
  level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR',
  event: string,
  detail: Record<string, unknown>
) => void

export class DeliveryOwner {
  private db: Database | undefined
  private reader: Database | undefined
  private ready = false
  private last: OwnerRow = {
    owner: 'injector',
    changed_at: null,
    delivering_owner: null,
    delivering_pid: null,
    delivering_since: null,
  }
  constructor(private path: string) {}
  private ensure(): Database {
    if (!this.db) {
      this.db = new Database(this.path, { create: true })
      this.db.exec('PRAGMA busy_timeout=1000')
    }
    if (!this.ready) {
      this.db.exec(OWNER_SCHEMA)
      this.ready = true
    }
    return this.db
  }
  read(): OwnerRow {
    if (!this.reader) {
      if (!existsSync(this.path)) return { ...this.last }
      this.reader = new Database(this.path, { readonly: true })
      this.reader.exec('PRAGMA busy_timeout=0')
    }
    try {
      this.last = this.reader
        .query<OwnerRow, []>('SELECT * FROM delivery_owner WHERE singleton = 1')
        .get() ?? {
        owner: 'injector',
        changed_at: null,
        delivering_owner: null,
        delivering_pid: null,
        delivering_since: null,
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'no such table: delivery_owner') {
        this.last = {
          owner: 'injector',
          changed_at: null,
          delivering_owner: null,
          delivering_pid: null,
          delivering_since: null,
        }
      } else if (
        !(
          error instanceof Error &&
          'code' in error &&
          (error.code === 'SQLITE_BUSY' || error.code === 'SQLITE_LOCKED')
        )
      ) {
        throw error
      }
    }
    return { ...this.last }
  }
  setOwner(owner: Owner) {
    const db = this.ensure()
    db.query(
      'INSERT INTO delivery_owner (singleton, owner, changed_at) VALUES (1, ?, ?) ON CONFLICT(singleton) DO UPDATE SET owner=excluded.owner, changed_at=excluded.changed_at'
    ).run(owner, new Date().toISOString())
  }
  report(owner: Owner, pid: number) {
    const db = this.ensure()
    db.query(
      "INSERT OR IGNORE INTO delivery_owner (singleton, owner, changed_at) VALUES (1, 'injector', ?)"
    ).run(new Date().toISOString())
    db.query(
      'UPDATE delivery_owner SET delivering_owner=?, delivering_pid=?, delivering_since=? WHERE singleton=1'
    ).run(owner, pid, new Date().toISOString())
  }
  clear() {
    const db = this.db
    if (!db) return
    db.exec(
      'UPDATE delivery_owner SET delivering_owner=NULL, delivering_pid=NULL, delivering_since=NULL WHERE singleton=1'
    )
  }
  close() {
    this.reader?.close()
    this.db?.close()
  }
}

export class DelivererLock {
  private db: Database | undefined
  private held = false
  private closed = false
  readonly path: string
  constructor(statePath: string) {
    this.path = join(dirname(statePath), 'hrc-mail-injector.deliverer-lock.sqlite')
  }
  tryAcquire(): boolean {
    if (this.closed) throw new Error('deliverer lock is closed')
    if (this.held) return true
    if (!this.db) {
      this.db = new Database(this.path, { create: true })
      this.db.exec('PRAGMA busy_timeout=0')
    }
    try {
      this.db.exec('BEGIN EXCLUSIVE')
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        (error.code === 'SQLITE_BUSY' || error.code === 'SQLITE_LOCKED')
      )
        return false
      throw error
    }
    this.held = true
    return true
  }
  release() {
    if (this.held) {
      this.db?.exec('ROLLBACK')
      this.held = false
    }
  }
  close() {
    this.db?.close()
    this.held = false
    this.closed = true
  }
}

export class InjectorOwnerLoop {
  private controller: StartedMailInjector | undefined
  private stopping = false
  private waiting = false
  private announced = false
  private mode: string | undefined
  private pending: Promise<void> = Promise.resolve()
  constructor(
    private flag: DeliveryOwner,
    private lock: DelivererLock,
    private start: () => Promise<StartedMailInjector>,
    private log: Log
  ) {}

  private announce() {
    const delivering = this.controller !== undefined
    // launchd proves process health; memos anchors each fresh controller here.
    this.log('INFO', 'mail_injector.started', {
      status: 'running',
      delivering,
      subscriber: 'mail',
      ...(this.controller
        ? { statePath: this.controller.statePath, importMarker: this.controller.importMarker }
        : {}),
    })
    this.announced = true
  }
  private announceMode() {
    const mode = this.controller ? 'delivering' : 'standing_by'
    if (mode !== this.mode) {
      this.log('INFO', 'mail_injector.mode', { mode })
      this.mode = mode
    }
  }
  private async standDown() {
    if (!this.controller) return
    await this.controller.stop()
    // Leave the controller reference until reporting clears successfully, so
    // a transient database failure retries cleanup rather than starting again.
    this.flag.clear()
    this.controller = undefined
    this.lock.release()
    this.announceMode()
  }
  step(): Promise<void> {
    const operation = this.pending.then(async () => {
      if (this.stopping) return
      const owner = this.flag.read().owner
      if (owner === 'injector' && !this.controller) {
        if (this.lock.tryAcquire()) {
          this.waiting = false
          this.flag.report('injector', process.pid)
          // A start failure is fatal: retain the lock until process exit.
          // No controller can outlive the process that owns this transaction.
          this.controller = await this.start()
          this.announce()
        } else if (!this.waiting) {
          this.log('INFO', 'mail_injector.lock_wait', {
            holder_pid: this.flag.read().delivering_pid,
          })
          this.waiting = true
        }
      } else if (owner === 'port') {
        await this.standDown()
        this.waiting = false
      }
      if (!this.announced) this.announce()
      this.announceMode()
    })
    this.pending = operation.catch(() => {})
    return operation
  }
  async stop() {
    this.stopping = true
    await this.pending
    await this.standDown()
  }
}
