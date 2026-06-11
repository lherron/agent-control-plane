import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import { DeliveryTargetResolver } from './delivery-target-resolver.js'
import { BindingRepo } from './repos/binding-repo.js'
import { DeliveryRequestRepo } from './repos/delivery-request-repo.js'
import { LastDeliveryContextRepo } from './repos/last-delivery-context-repo.js'
import { MessageSourceRepo } from './repos/message-source-repo.js'
import { OutboundAttachmentRepo } from './repos/outbound-attachment-repo.js'
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
  readonly outboundAttachments: OutboundAttachmentRepo
  runInTransaction<T>(fn: (store: InterfaceStore) => T): T
  close(): void
}

const SQLITE_BUSY_TIMEOUT_MS = 5000

function isEphemeralPath(path: string): boolean {
  return path === '' || path === ':memory:'
}

function addColumnIfMissing(sqlite: SqliteDatabase, table: string, columnDef: string): void {
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

function initializeSchema(sqlite: SqliteDatabase): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS interface_bindings (
      binding_id TEXT PRIMARY KEY,
      gateway_id TEXT NOT NULL,
      gateway_type TEXT NOT NULL DEFAULT 'unknown',
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
      body_attachments_json TEXT,
      outcome_state TEXT,
      outcome_reason TEXT,
      outcome_source TEXT,
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

    CREATE TABLE IF NOT EXISTS delivery_request_idempotency (
      route TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      fingerprint_hash TEXT NOT NULL,
      delivery_request_id TEXT NOT NULL REFERENCES delivery_requests(delivery_request_id),
      created_at TEXT NOT NULL,
      PRIMARY KEY (route, idempotency_key)
    );

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

    CREATE TABLE IF NOT EXISTS outbound_attachments (
      outboundAttachmentId TEXT PRIMARY KEY,
      runId TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'consumed', 'delivered', 'failed')),
      consumedByDeliveryRequestId TEXT NULL,
      path TEXT NOT NULL,
      filename TEXT NOT NULL,
      contentType TEXT NOT NULL,
      sizeBytes INTEGER NOT NULL,
      alt TEXT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS outbound_attachments_run_state_idx
      ON outbound_attachments (runId, state);
  `)

  addColumnIfMissing(
    sqlite,
    'delivery_requests',
    'linked_failure_id TEXT REFERENCES delivery_requests(delivery_request_id)'
  )
  addColumnIfMissing(sqlite, 'interface_bindings', "gateway_type TEXT NOT NULL DEFAULT 'unknown'")
  backfillGatewayType(sqlite)

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
    addColumnIfMissing(sqlite, table, columnDef)
  }

  addColumnIfMissing(sqlite, 'delivery_requests', 'body_attachments_json TEXT')

  const deliveryOutcomeColumns = [
    ['delivery_requests', 'outcome_state TEXT'],
    ['delivery_requests', 'outcome_reason TEXT'],
    ['delivery_requests', 'outcome_source TEXT'],
    ['delivery_requests', 'outcome_details_json TEXT'],
  ] as const

  for (const [table, columnDef] of deliveryOutcomeColumns) {
    addColumnIfMissing(sqlite, table, columnDef)
  }

  migrateStructuredScopeColumns(sqlite)
  tightenInterfaceBindingsConstraints(sqlite)
  ensureInterfaceBindingIndexes(sqlite)
}

/**
 * Step 5+6: drop scope_ref column and enforce NOT NULL on agent_id/project_id
 * via a table rebuild. Idempotent — only rebuilds when the legacy scope_ref
 * column or nullable structured columns are still present.
 *
 * Skips the rebuild and logs to stderr if any active row would fail the new
 * constraints; operators must repair via `acp admin interface binding lint`.
 */
function tightenInterfaceBindingsConstraints(sqlite: SqliteDatabase): void {
  const cols = sqlite
    .prepare(
      `SELECT name, "notnull" AS not_null_flag
         FROM pragma_table_info('interface_bindings')`
    )
    .all() as Array<{ name: string; not_null_flag: number }>

  const byName = new Map(cols.map((c) => [c.name, c]))
  const hasScopeRef = byName.has('scope_ref')
  const agentIdCol = byName.get('agent_id')
  const projectIdCol = byName.get('project_id')
  const agentIdNotNull = agentIdCol?.not_null_flag === 1
  const projectIdNotNull = projectIdCol?.not_null_flag === 1

  if (!hasScopeRef && agentIdNotNull && projectIdNotNull) {
    return
  }

  const offenders = sqlite
    .prepare(
      `SELECT binding_id
         FROM interface_bindings
        WHERE status = 'active'
          AND (agent_id IS NULL OR project_id IS NULL)`
    )
    .all() as Array<{ binding_id: string }>

  if (offenders.length > 0) {
    process.stderr.write(
      `[acp-interface-store] Skipping interface_bindings constraint tightening: ${offenders.length} active binding(s) lack agent_id/project_id (first: ${offenders[0]?.binding_id}). Run 'acp admin interface binding lint' and repair them, then reopen the store.\n`
    )
    return
  }

  sqlite.exec(`
    BEGIN;
    CREATE TABLE interface_bindings_new (
      binding_id TEXT PRIMARY KEY,
      gateway_id TEXT NOT NULL,
      gateway_type TEXT NOT NULL DEFAULT 'unknown',
      conversation_ref TEXT NOT NULL,
      thread_ref TEXT,
      lane_ref TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      task_id TEXT,
      role_name TEXT,
      status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
      actor_kind TEXT,
      actor_id TEXT,
      actor_display_name TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (length(agent_id) > 0),
      CHECK (length(project_id) > 0)
    );

    INSERT INTO interface_bindings_new (
      binding_id, gateway_id, gateway_type, conversation_ref, thread_ref, lane_ref,
      agent_id, project_id, task_id, role_name,
      status, actor_kind, actor_id, actor_display_name,
      created_at, updated_at
    )
    SELECT
      binding_id, gateway_id, COALESCE(NULLIF(gateway_type, ''), 'unknown'), conversation_ref, thread_ref, lane_ref,
      agent_id, project_id, task_id, role_name,
      status, actor_kind, actor_id, actor_display_name,
      created_at, updated_at
    FROM interface_bindings
    WHERE agent_id IS NOT NULL AND project_id IS NOT NULL;

    DROP TABLE interface_bindings;
    ALTER TABLE interface_bindings_new RENAME TO interface_bindings;

    CREATE UNIQUE INDEX IF NOT EXISTS interface_bindings_lookup_unique
      ON interface_bindings (gateway_id, conversation_ref, COALESCE(thread_ref, ''));

    CREATE INDEX IF NOT EXISTS interface_bindings_list_idx
      ON interface_bindings (gateway_id, conversation_ref, thread_ref, project_id);

    CREATE INDEX IF NOT EXISTS interface_bindings_by_scope_idx
      ON interface_bindings (agent_id, project_id, task_id, role_name, lane_ref);

    CREATE INDEX IF NOT EXISTS interface_bindings_primary_resolution_idx
      ON interface_bindings (gateway_type, status, agent_id, project_id, task_id, role_name, lane_ref);

    COMMIT;
  `)
}

function backfillGatewayType(sqlite: SqliteDatabase): void {
  sqlite.exec(`
    UPDATE interface_bindings
       SET gateway_type = 'discord'
     WHERE gateway_id = 'acp-discord-smoke'
       AND (gateway_type IS NULL OR gateway_type = '' OR gateway_type = 'unknown');
  `)
}

function ensureInterfaceBindingIndexes(sqlite: SqliteDatabase): void {
  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS interface_bindings_primary_resolution_idx
      ON interface_bindings (gateway_type, status, agent_id, project_id, task_id, role_name, lane_ref);
  `)
}

function migrateStructuredScopeColumns(sqlite: SqliteDatabase): void {
  const structuredColumns = [
    ['interface_bindings', 'agent_id TEXT'],
    ['interface_bindings', 'task_id TEXT'],
    ['interface_bindings', 'role_name TEXT'],
  ] as const

  let didAdd = false
  for (const [table, columnDef] of structuredColumns) {
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
      didAdd = true
    }
  }

  if (didAdd) {
    backfillStructuredScopeColumns(sqlite)
  }
}

function backfillStructuredScopeColumns(sqlite: SqliteDatabase): void {
  // Backfill agent_id, task_id, role_name from scope_ref for every row.
  // scope_ref format: agent:<id>[:project:<id>[:task:<id>][:role:<name>]]
  // SQLite has no regex; we use a series of substring extractions.
  sqlite.exec(`
    UPDATE interface_bindings
       SET agent_id = CASE
             WHEN scope_ref LIKE 'agent:%'
               THEN
                 CASE
                   WHEN instr(substr(scope_ref, 7), ':') > 0
                     THEN substr(scope_ref, 7, instr(substr(scope_ref, 7), ':') - 1)
                   ELSE substr(scope_ref, 7)
                 END
             ELSE agent_id
           END
     WHERE agent_id IS NULL;
  `)

  // task_id: only present after ":task:" segment.
  sqlite.exec(`
    UPDATE interface_bindings
       SET task_id = (
             SELECT CASE
               WHEN instr(scope_ref, ':task:') > 0 THEN
                 CASE
                   WHEN instr(substr(scope_ref, instr(scope_ref, ':task:') + 6), ':') > 0 THEN
                     substr(
                       scope_ref,
                       instr(scope_ref, ':task:') + 6,
                       instr(substr(scope_ref, instr(scope_ref, ':task:') + 6), ':') - 1
                     )
                   ELSE substr(scope_ref, instr(scope_ref, ':task:') + 6)
                 END
               ELSE NULL
             END
           )
     WHERE task_id IS NULL
       AND instr(scope_ref, ':task:') > 0;
  `)

  // role_name: only present after ":role:" segment (always trailing in the grammar).
  sqlite.exec(`
    UPDATE interface_bindings
       SET role_name = substr(scope_ref, instr(scope_ref, ':role:') + 6)
     WHERE role_name IS NULL
       AND instr(scope_ref, ':role:') > 0;
  `)

  // project_id: backfill from scope_ref when null and scope has a project segment.
  sqlite.exec(`
    UPDATE interface_bindings
       SET project_id = (
             SELECT CASE
               WHEN instr(scope_ref, ':project:') > 0 THEN
                 CASE
                   WHEN instr(substr(scope_ref, instr(scope_ref, ':project:') + 9), ':') > 0 THEN
                     substr(
                       scope_ref,
                       instr(scope_ref, ':project:') + 9,
                       instr(substr(scope_ref, instr(scope_ref, ':project:') + 9), ':') - 1
                     )
                   ELSE substr(scope_ref, instr(scope_ref, ':project:') + 9)
                 END
               ELSE NULL
             END
           )
     WHERE project_id IS NULL
       AND instr(scope_ref, ':project:') > 0;
  `)
}

function createSqliteDatabase(dbPath: string): SqliteDatabase {
  if (!isEphemeralPath(dbPath)) {
    mkdirSync(dirname(dbPath), { recursive: true })
  }

  const sqlite = new Database(dbPath)
  sqlite.exec('PRAGMA journal_mode = WAL;')
  sqlite.exec('PRAGMA foreign_keys = ON;')
  sqlite.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};`)
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
    outboundAttachments: new OutboundAttachmentRepo(context),
    runInTransaction<T>(fn: (activeStore: InterfaceStore) => T): T {
      return sqlite.transaction(() => fn(store))()
    },
    close(): void {
      sqlite.close()
    },
  } satisfies InterfaceStore

  return store
}
