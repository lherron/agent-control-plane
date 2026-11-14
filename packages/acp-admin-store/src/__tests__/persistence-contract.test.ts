import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { adminStoreMigrations, openSqliteAdminStore, runAdminStoreMigrations } from '../index.js'

test('disk reopen preserves migration ledger, schema, data and connection pragmas', () => {
  const dir = mkdtempSync(join(tmpdir(), 'admin-persistence-'))
  const dbPath = join(dir, 'nested/admin.db')
  const actor = { kind: 'human', id: 'operator' } as const
  const now = '2026-11-14T08:00:00.000Z'
  let store = openSqliteAdminStore({ dbPath })
  try {
    store.agents.create({ agentId: 'a', status: 'active', actor, now })
    const schema = store.sqlite.prepare('SELECT sql FROM sqlite_master ORDER BY name').all()
    const ledger = store.sqlite
      .prepare('SELECT * FROM acp_admin_store_migrations ORDER BY id')
      .all()
    runAdminStoreMigrations(store.sqlite)
    store.close()
    store = openSqliteAdminStore({ dbPath })
    expect(store.migrations.applied).toEqual(adminStoreMigrations.map((migration) => migration.id))
    expect(
      store.sqlite.prepare('SELECT * FROM acp_admin_store_migrations ORDER BY id').all()
    ).toEqual(ledger)
    expect(store.sqlite.prepare('SELECT sql FROM sqlite_master ORDER BY name').all()).toEqual(
      schema
    )
    expect(store.sqlite.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' })
    expect(store.sqlite.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 })
    expect(store.sqlite.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 5000 })
    expect(store.agents.get('a')?.createdBy).toEqual(actor)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('cross-repository transactions notify on commit and roll back together', () => {
  const commits: string[][] = []
  const store = openSqliteAdminStore({
    dbPath: ':memory:',
    onCommit: (tables) => commits.push([...tables].sort()),
  })
  const actor = { kind: 'agent', id: 'cody' } as const
  const now = '2026-11-14T08:00:00.000Z'
  try {
    expect(commits).toEqual([])
    const write = () =>
      store.runInTransaction((active) => {
        expect(active).toBe(store)
        active.agents.create({ agentId: 'a', status: 'active', actor, now })
        active.projects.create({ projectId: 'p', displayName: 'P', actor, now })
        expect(commits).toEqual([])
        return 'committed'
      })
    expect(() =>
      store.runInTransaction(() => {
        write()
        throw Error('rollback')
      })
    ).toThrow('rollback')
    expect(store.agents.list()).toEqual([])
    expect(store.projects.list()).toEqual([])
    expect(commits).toEqual([])
    expect(write()).toBe('committed')
    expect(commits).toEqual([['agents', 'projects']])
  } finally {
    store.close()
  }
})
