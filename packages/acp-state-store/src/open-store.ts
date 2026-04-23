import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import { InputAttemptRepo } from './repos/input-attempt-repo.js'
import { RunRepo } from './repos/run-repo.js'
import type { RepoContext } from './repos/shared.js'
import { TransitionOutboxRepo } from './repos/transition-outbox-repo.js'
import Database, { type SqliteDatabase } from './sqlite.js'

export interface OpenAcpStateStoreOptions {
  dbPath: string
}

export interface AcpStateStore {
  readonly sqlite: SqliteDatabase
  readonly runs: RunRepo
  readonly inputAttempts: InputAttemptRepo
  readonly transitionOutbox: TransitionOutboxRepo
  runInTransaction<T>(fn: (store: AcpStateStore) => T): T
  close(): void
}

function isEphemeralPath(path: string): boolean {
  return path === '' || path === ':memory:'
}

function initializeSchema(sqlite: SqliteDatabase): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      run_id TEXT PRIMARY KEY,
      scope_ref TEXT NOT NULL,
      lane_ref TEXT NOT NULL,
      task_id TEXT,
      actor_kind TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      actor_display_name TEXT,
      status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
      hrc_run_id TEXT,
      host_session_id TEXT,
      generation INTEGER,
      runtime_id TEXT,
      transport TEXT,
      error_code TEXT,
      error_message TEXT,
      dispatch_fence_json TEXT,
      expected_host_session_id TEXT,
      expected_generation INTEGER,
      follow_latest INTEGER CHECK (follow_latest IN (0, 1) OR follow_latest IS NULL),
      metadata_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS runs_session_idx
      ON runs (scope_ref, lane_ref, created_at);

    CREATE TABLE IF NOT EXISTS input_attempts (
      input_attempt_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      scope_ref TEXT NOT NULL,
      lane_ref TEXT NOT NULL,
      task_id TEXT,
      idempotency_key TEXT,
      fingerprint TEXT NOT NULL,
      content TEXT NOT NULL,
      actor_kind TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      actor_display_name TEXT,
      metadata_json TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES runs(run_id)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS input_attempts_idempotency_unique
      ON input_attempts (scope_ref, lane_ref, idempotency_key)
      WHERE idempotency_key IS NOT NULL;

    CREATE INDEX IF NOT EXISTS input_attempts_run_idx
      ON input_attempts (run_id, created_at);

    CREATE TABLE IF NOT EXISTS transition_outbox (
      transition_event_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      from_phase TEXT NOT NULL,
      to_phase TEXT NOT NULL,
      actor_kind TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      actor_display_name TEXT,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'leased', 'delivered', 'failed')),
      leased_at TEXT,
      delivered_at TEXT,
      attempts INTEGER NOT NULL,
      last_error TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS transition_outbox_status_idx
      ON transition_outbox (status, created_at);
  `)
}

type TableInfoRow = {
  name: string
}

function listTableColumns(sqlite: SqliteDatabase, tableName: string): Set<string> {
  const rows = sqlite.prepare(`PRAGMA table_info(${tableName})`).all() as TableInfoRow[]

  return new Set(rows.map((row) => row.name))
}

function addColumnIfMissing(
  sqlite: SqliteDatabase,
  tableName: string,
  columns: Set<string>,
  columnName: string,
  definition: string
): void {
  if (columns.has(columnName)) {
    return
  }

  sqlite.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`)
  columns.add(columnName)
}

function migrateRunsActorColumns(sqlite: SqliteDatabase): void {
  const columns = listTableColumns(sqlite, 'runs')
  addColumnIfMissing(sqlite, 'runs', columns, 'actor_kind', "TEXT NOT NULL DEFAULT ''")
  addColumnIfMissing(sqlite, 'runs', columns, 'actor_id', "TEXT NOT NULL DEFAULT ''")
  addColumnIfMissing(sqlite, 'runs', columns, 'actor_display_name', 'TEXT')

  sqlite.exec(`
    UPDATE runs
       SET actor_kind = CASE WHEN actor_kind = '' THEN 'system' ELSE actor_kind END,
           actor_id = CASE WHEN actor_id = '' THEN 'acp-local' ELSE actor_id END
     WHERE actor_kind = '' OR actor_id = ''
  `)
}

function migrateInputAttemptsActorColumns(sqlite: SqliteDatabase): void {
  const columns = listTableColumns(sqlite, 'input_attempts')
  const hasLegacyActorAgentId = columns.has('actor_agent_id')

  addColumnIfMissing(sqlite, 'input_attempts', columns, 'actor_kind', "TEXT NOT NULL DEFAULT ''")
  addColumnIfMissing(sqlite, 'input_attempts', columns, 'actor_id', "TEXT NOT NULL DEFAULT ''")
  addColumnIfMissing(sqlite, 'input_attempts', columns, 'actor_display_name', 'TEXT')

  if (hasLegacyActorAgentId) {
    sqlite.exec(`
      UPDATE input_attempts
         SET actor_kind = CASE
                            WHEN actor_kind = '' AND actor_agent_id IS NOT NULL AND actor_agent_id != ''
                              THEN 'agent'
                            WHEN actor_kind = ''
                              THEN 'system'
                            ELSE actor_kind
                          END,
             actor_id = CASE
                          WHEN actor_id = '' AND actor_agent_id IS NOT NULL AND actor_agent_id != ''
                            THEN actor_agent_id
                          WHEN actor_id = ''
                            THEN 'acp-local'
                          ELSE actor_id
                        END
       WHERE actor_kind = '' OR actor_id = ''
    `)

    return
  }

  sqlite.exec(`
    UPDATE input_attempts
       SET actor_kind = CASE WHEN actor_kind = '' THEN 'system' ELSE actor_kind END,
           actor_id = CASE WHEN actor_id = '' THEN 'acp-local' ELSE actor_id END
     WHERE actor_kind = '' OR actor_id = ''
  `)
}

function migrateTransitionOutboxActorColumns(sqlite: SqliteDatabase): void {
  const columns = listTableColumns(sqlite, 'transition_outbox')
  addColumnIfMissing(sqlite, 'transition_outbox', columns, 'actor_kind', "TEXT NOT NULL DEFAULT ''")
  addColumnIfMissing(sqlite, 'transition_outbox', columns, 'actor_id', "TEXT NOT NULL DEFAULT ''")
  addColumnIfMissing(sqlite, 'transition_outbox', columns, 'actor_display_name', 'TEXT')

  sqlite.exec(`
    UPDATE transition_outbox
       SET actor_kind = CASE WHEN actor_kind = '' THEN 'system' ELSE actor_kind END,
           actor_id = CASE WHEN actor_id = '' THEN 'acp-local' ELSE actor_id END
     WHERE actor_kind = '' OR actor_id = ''
  `)
}

function migrateLegacySchema(sqlite: SqliteDatabase): void {
  sqlite.transaction(() => {
    migrateRunsActorColumns(sqlite)
    migrateInputAttemptsActorColumns(sqlite)
    migrateTransitionOutboxActorColumns(sqlite)
  })()
}

function createSqliteDatabase(dbPath: string): SqliteDatabase {
  if (!isEphemeralPath(dbPath)) {
    mkdirSync(dirname(dbPath), { recursive: true })
  }

  const sqlite = new Database(dbPath)
  sqlite.exec('PRAGMA journal_mode = WAL;')
  sqlite.exec('PRAGMA foreign_keys = ON;')
  sqlite.exec('PRAGMA busy_timeout = 5000;')
  return sqlite
}

export function openAcpStateStore(options: OpenAcpStateStoreOptions): AcpStateStore {
  const sqlite = createSqliteDatabase(options.dbPath)
  initializeSchema(sqlite)
  migrateLegacySchema(sqlite)

  const context: RepoContext = {
    sqlite,
  }

  const store = {
    sqlite,
    runs: new RunRepo(context),
    inputAttempts: new InputAttemptRepo(context),
    transitionOutbox: new TransitionOutboxRepo(context),
    runInTransaction<T>(fn: (activeStore: AcpStateStore) => T): T {
      return sqlite.transaction(() => fn(store))()
    },
    close(): void {
      sqlite.close()
    },
  } satisfies AcpStateStore

  return store
}
