import { existsSync } from 'node:fs'

import { ActorResolver, type StoreActorIdentity } from './actor-resolver.js'
import { WrkqSchemaMissingError } from './errors.js'
import { EvidenceRepo } from './repos/evidence-repo.js'
import { RoleAssignmentRepo } from './repos/role-assignment-repo.js'
import type { RepoContext } from './repos/shared.js'
import { TaskRepo } from './repos/task-repo.js'
import { TransitionLogRepo } from './repos/transition-log-repo.js'
import Database, { type SqliteDatabase } from './sqlite.js'

type TableInfoRow = {
  name: string
}

type SQLiteMasterRow = {
  name: string
}

export interface OpenWrkqStoreOptions {
  dbPath: string
  actor: StoreActorIdentity
}

export interface WrkqStore {
  readonly sqlite: SqliteDatabase
  readonly taskRepo: TaskRepo
  readonly evidenceRepo: EvidenceRepo
  readonly roleAssignmentRepo: RoleAssignmentRepo
  readonly transitionLogRepo: TransitionLogRepo
  runInTransaction<T>(fn: (store: WrkqStore) => T): T
  close(): void
}

function listMissingSchemaParts(sqlite: SqliteDatabase): string[] {
  const missing: string[] = []

  const tables = new Set(
    (
      sqlite
        .prepare(
          `SELECT name
             FROM sqlite_master
            WHERE type = 'table'
              AND name IN ('actors', 'containers', 'tasks', 'task_role_assignments', 'evidence_items', 'task_transitions')`
        )
        .all() as SQLiteMasterRow[]
    ).map((row) => row.name)
  )

  for (const requiredTable of [
    'actors',
    'containers',
    'tasks',
    'task_role_assignments',
    'evidence_items',
    'task_transitions',
  ]) {
    if (!tables.has(requiredTable)) {
      missing.push(`table:${requiredTable}`)
    }
  }

  if (!tables.has('tasks')) {
    return missing
  }

  const taskColumns = new Set(
    (sqlite.prepare('PRAGMA table_info(tasks)').all() as TableInfoRow[]).map((row) => row.name)
  )

  for (const requiredColumn of ['workflow_preset', 'preset_version', 'phase', 'risk_class']) {
    if (!taskColumns.has(requiredColumn)) {
      missing.push(`tasks.${requiredColumn}`)
    }
  }

  return missing
}

export function assertWrkqSchemaPresent(sqlite: SqliteDatabase, dbPath: string): void {
  const missing = listMissingSchemaParts(sqlite)
  if (missing.length > 0) {
    throw new WrkqSchemaMissingError(missing, dbPath)
  }
}

export function openWrkqStore(options: OpenWrkqStoreOptions): WrkqStore {
  if (!existsSync(options.dbPath)) {
    throw new Error(`wrkq database not found: ${options.dbPath}`)
  }

  const sqlite = new Database(options.dbPath)
  sqlite.pragma('foreign_keys = ON')
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('busy_timeout = 5000')
  assertWrkqSchemaPresent(sqlite, options.dbPath)

  const actorResolver = new ActorResolver(sqlite, options.actor)
  const context: RepoContext = {
    sqlite,
    actorResolver,
  }

  const taskRepo = new TaskRepo(context)
  const evidenceRepo = new EvidenceRepo(context)
  const roleAssignmentRepo = new RoleAssignmentRepo(context)
  const transitionLogRepo = new TransitionLogRepo(context)

  const store = {
    sqlite,
    taskRepo,
    evidenceRepo,
    roleAssignmentRepo,
    transitionLogRepo,
    runInTransaction<T>(fn: (wrqkStore: WrkqStore) => T): T {
      return sqlite.transaction((callback: () => T) => callback())(() => fn(store))
    },
    close(): void {
      sqlite.close()
    },
  } satisfies WrkqStore

  return store
}
