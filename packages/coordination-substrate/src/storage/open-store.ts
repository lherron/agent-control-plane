import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export type CoordinationStore = {
  sqlite: Database
  close(): void
  migrations: {
    applied: string[]
  }
}

type Migration = {
  id: string
  assetPath: string
}

type MigrationRow = {
  id: string
}

const migrations: readonly Migration[] = [
  { id: '001_initial', assetPath: 'migrations/001_initial.sql' },
]

function isEphemeralPath(path: string): boolean {
  return path === '' || path === ':memory:'
}

function resolveStorageAssetPath(relativePath: string): string {
  const currentDirectory = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(currentDirectory, relativePath),
    join(currentDirectory, '..', '..', 'src', 'storage', relativePath),
  ]

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate
    }
  }

  throw new Error(`Unable to resolve coordination storage asset: ${relativePath}`)
}

function ensureMigrationTable(sqlite: Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS coordination_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `)
}

export function createCoordinationDatabase(path: string): Database {
  if (!isEphemeralPath(path)) {
    mkdirSync(dirname(path), { recursive: true })
  }

  const sqlite = new Database(path)
  sqlite.exec('PRAGMA journal_mode = WAL;')
  sqlite.exec('PRAGMA foreign_keys = ON;')
  sqlite.exec('PRAGMA busy_timeout = 5000;')
  return sqlite
}

export function listAppliedMigrations(sqlite: Database): string[] {
  ensureMigrationTable(sqlite)
  return sqlite
    .query<MigrationRow, []>('SELECT id FROM coordination_migrations ORDER BY id ASC')
    .all()
    .map((row) => row.id)
}

export function runMigrations(sqlite: Database): void {
  ensureMigrationTable(sqlite)
  const applied = new Set(listAppliedMigrations(sqlite))

  sqlite.transaction((pending: readonly Migration[]) => {
    for (const migration of pending) {
      if (applied.has(migration.id)) {
        continue
      }

      sqlite.exec(readFileSync(resolveStorageAssetPath(migration.assetPath), 'utf8'))
      sqlite
        .query('INSERT INTO coordination_migrations (id, applied_at) VALUES (?, ?)')
        .run(migration.id, new Date().toISOString())
    }
  })(migrations)
}

export function readSchemaSql(): string {
  return readFileSync(resolveStorageAssetPath('schema.sql'), 'utf8')
}

export function openCoordinationStore(dbPath: string): CoordinationStore {
  const sqlite = createCoordinationDatabase(dbPath)
  runMigrations(sqlite)

  return {
    sqlite,
    close() {
      sqlite.close()
    },
    migrations: {
      applied: listAppliedMigrations(sqlite),
    },
  }
}
