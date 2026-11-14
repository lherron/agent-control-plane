import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { observeSqliteCommits } from 'acp-core'
import { type AgentsStore, createAgentsStore } from './agents-store.js'
import { type HeartbeatsStore, createHeartbeatsStore } from './heartbeats-store.js'
import {
  type InterfaceIdentitiesStore,
  createInterfaceIdentitiesStore,
} from './interface-identities-store.js'
import { type MembershipsStore, createMembershipsStore } from './memberships-store.js'
import { listAppliedAdminStoreMigrations, runAdminStoreMigrations } from './migrations.js'
import { type ProjectsStore, createProjectsStore } from './projects-store.js'
import Database, { type SqliteDatabase } from './sqlite.js'
import { type SystemEventsStore, createSystemEventsStore } from './system-events-store.js'

export interface OpenSqliteAdminStoreOptions {
  onCommit?: ((tables: ReadonlySet<string>) => void) | undefined
  dbPath: string
}

export interface AdminStore {
  readonly sqlite: SqliteDatabase
  readonly migrations: {
    applied: string[]
  }
  readonly agents: AgentsStore
  readonly projects: ProjectsStore
  readonly memberships: MembershipsStore
  readonly interfaceIdentities: InterfaceIdentitiesStore
  readonly systemEvents: SystemEventsStore
  readonly heartbeats: HeartbeatsStore
  runInTransaction<T>(fn: (store: AdminStore) => T): T
  close(): void
}

function isEphemeralPath(path: string): boolean {
  return path === '' || path === ':memory:'
}

const SQLITE_BUSY_TIMEOUT_MS = 5000

function createSqliteDatabase(dbPath: string): SqliteDatabase {
  if (!isEphemeralPath(dbPath)) {
    mkdirSync(dirname(dbPath), { recursive: true })
  }

  const sqlite = new Database(dbPath)
  // busy_timeout first: journal_mode takes a lock, and without a timeout a
  // concurrent writer or closing checkpoint fails the open with SQLITE_BUSY.
  sqlite.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};`)
  sqlite.exec('PRAGMA journal_mode = WAL;')
  sqlite.exec('PRAGMA foreign_keys = ON;')
  return sqlite
}

export function openSqliteAdminStore(options: OpenSqliteAdminStoreOptions): AdminStore {
  const rawSqlite = createSqliteDatabase(options.dbPath)
  runAdminStoreMigrations(rawSqlite)
  const sqlite = observeSqliteCommits(rawSqlite, options.onCommit)

  const agents = createAgentsStore(sqlite)
  const projects = createProjectsStore(sqlite)
  const memberships = createMembershipsStore(sqlite)
  const interfaceIdentities = createInterfaceIdentitiesStore(sqlite)
  const systemEvents = createSystemEventsStore(sqlite)
  const heartbeats = createHeartbeatsStore(sqlite)

  const store = {
    sqlite,
    migrations: {
      applied: listAppliedAdminStoreMigrations(sqlite),
    },
    agents,
    projects,
    memberships,
    interfaceIdentities,
    systemEvents,
    heartbeats,
    runInTransaction<T>(fn: (activeStore: AdminStore) => T): T {
      return sqlite.transaction(() => fn(store))()
    },
    close(): void {
      sqlite.close()
    },
  } satisfies AdminStore

  return store
}

export function createInMemoryAdminStore(): AdminStore {
  return openSqliteAdminStore({ dbPath: ':memory:' })
}
