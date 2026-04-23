import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import { DeliveryTargetResolver } from './delivery-target-resolver.js'
import { BindingRepo } from './repos/binding-repo.js'
import { DeliveryRequestRepo } from './repos/delivery-request-repo.js'
import { LastDeliveryContextRepo } from './repos/last-delivery-context-repo.js'
import { MessageSourceRepo } from './repos/message-source-repo.js'
import type { RepoContext } from './repos/shared.js'
import Database, { type SqliteDatabase } from './sqlite.js'
import type { InterfaceStoreActorIdentity } from './types.js'

export interface OpenInterfaceStoreOptions {
  dbPath: string
  actor?: InterfaceStoreActorIdentity | undefined
}

export interface InterfaceStore {
  readonly sqlite: SqliteDatabase
  readonly bindings: BindingRepo
  readonly deliveries: DeliveryRequestRepo
  readonly lastDeliveryContext: LastDeliveryContextRepo
  readonly deliveryTargets: DeliveryTargetResolver
  readonly messageSources: MessageSourceRepo
  runInTransaction<T>(fn: (store: InterfaceStore) => T): T
  close(): void
}

function isEphemeralPath(path: string): boolean {
  return path === '' || path === ':memory:'
}

function initializeSchema(sqlite: SqliteDatabase): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS interface_bindings (
      binding_id TEXT PRIMARY KEY,
      gateway_id TEXT NOT NULL,
      conversation_ref TEXT NOT NULL,
      thread_ref TEXT,
      scope_ref TEXT NOT NULL,
      lane_ref TEXT NOT NULL,
      project_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
      actor_kind TEXT,
      actor_id TEXT,
      actor_display_name TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS interface_bindings_lookup_unique
      ON interface_bindings (gateway_id, conversation_ref, COALESCE(thread_ref, ''));

    CREATE INDEX IF NOT EXISTS interface_bindings_list_idx
      ON interface_bindings (gateway_id, conversation_ref, thread_ref, project_id);

    CREATE TABLE IF NOT EXISTS interface_message_sources (
      gateway_id TEXT NOT NULL,
      message_ref TEXT NOT NULL,
      binding_id TEXT NOT NULL,
      conversation_ref TEXT NOT NULL,
      thread_ref TEXT,
      author_ref TEXT NOT NULL,
      actor_kind TEXT,
      actor_id TEXT,
      actor_display_name TEXT,
      received_at TEXT NOT NULL,
      PRIMARY KEY (gateway_id, message_ref)
    );

    CREATE INDEX IF NOT EXISTS interface_message_sources_binding_idx
      ON interface_message_sources (binding_id, received_at);

    CREATE TABLE IF NOT EXISTS delivery_requests (
      delivery_request_id TEXT PRIMARY KEY,
      linked_failure_id TEXT REFERENCES delivery_requests(delivery_request_id),
      gateway_id TEXT NOT NULL,
      binding_id TEXT NOT NULL,
      scope_ref TEXT NOT NULL,
      lane_ref TEXT NOT NULL,
      run_id TEXT,
      input_attempt_id TEXT,
      conversation_ref TEXT NOT NULL,
      thread_ref TEXT,
      reply_to_message_ref TEXT,
      body_kind TEXT NOT NULL CHECK (body_kind IN ('text/markdown')),
      body_text TEXT NOT NULL,
      actor_kind TEXT,
      actor_id TEXT,
      actor_display_name TEXT,
      status TEXT NOT NULL CHECK (status IN ('queued', 'delivering', 'delivered', 'failed')),
      created_at TEXT NOT NULL,
      delivered_at TEXT,
      failure_code TEXT,
      failure_message TEXT
    );

    CREATE INDEX IF NOT EXISTS delivery_requests_gateway_queue_idx
      ON delivery_requests (gateway_id, status, created_at);

    CREATE INDEX IF NOT EXISTS delivery_requests_failed_idx
      ON delivery_requests (status, gateway_id, created_at);

    CREATE INDEX IF NOT EXISTS delivery_requests_binding_idx
      ON delivery_requests (binding_id, created_at);

    CREATE INDEX IF NOT EXISTS delivery_requests_run_idx
      ON delivery_requests (run_id, created_at);

    CREATE TABLE IF NOT EXISTS last_delivery_context (
      scope_ref TEXT NOT NULL,
      lane_ref TEXT NOT NULL,
      gateway_id TEXT NOT NULL,
      conversation_ref TEXT NOT NULL,
      thread_ref TEXT,
      delivery_request_id TEXT NOT NULL,
      actor_kind TEXT,
      actor_id TEXT,
      actor_display_name TEXT,
      acked_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (scope_ref, lane_ref)
    );
  `)

  const linkedFailureIdColumn = sqlite
    .prepare(
      `SELECT name
         FROM pragma_table_info('delivery_requests')
        WHERE name = 'linked_failure_id'`
    )
    .get()

  if (linkedFailureIdColumn === undefined) {
    sqlite.exec(`
      ALTER TABLE delivery_requests
      ADD COLUMN linked_failure_id TEXT REFERENCES delivery_requests(delivery_request_id);
    `)
  }

  const actorColumns = [
    ['interface_bindings', 'actor_kind TEXT'],
    ['interface_bindings', 'actor_id TEXT'],
    ['interface_bindings', 'actor_display_name TEXT'],
    ['interface_message_sources', 'actor_kind TEXT'],
    ['interface_message_sources', 'actor_id TEXT'],
    ['interface_message_sources', 'actor_display_name TEXT'],
    ['delivery_requests', 'actor_kind TEXT'],
    ['delivery_requests', 'actor_id TEXT'],
    ['delivery_requests', 'actor_display_name TEXT'],
    ['last_delivery_context', 'actor_kind TEXT'],
    ['last_delivery_context', 'actor_id TEXT'],
    ['last_delivery_context', 'actor_display_name TEXT'],
  ] as const

  for (const [table, columnDef] of actorColumns) {
    const columnName = columnDef.split(' ')[0]
    const existing = sqlite
      .prepare(
        `SELECT name
           FROM pragma_table_info('${table}')
          WHERE name = ?`
      )
      .get(columnName)
    if (existing === undefined) {
      sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef};`)
    }
  }
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

export function openInterfaceStore(options: OpenInterfaceStoreOptions): InterfaceStore {
  const sqlite = createSqliteDatabase(options.dbPath)
  initializeSchema(sqlite)

  const context: RepoContext = {
    sqlite,
  }

  const bindings = new BindingRepo(context)
  const deliveries = new DeliveryRequestRepo(context)
  const lastDeliveryContext = new LastDeliveryContextRepo(context)

  const store = {
    sqlite,
    bindings,
    deliveries,
    lastDeliveryContext,
    deliveryTargets: new DeliveryTargetResolver({
      bindings,
      lastDeliveryContext,
    }),
    messageSources: new MessageSourceRepo(context),
    runInTransaction<T>(fn: (activeStore: InterfaceStore) => T): T {
      return sqlite.transaction(() => fn(store))()
    },
    close(): void {
      sqlite.close()
    },
  } satisfies InterfaceStore

  return store
}
