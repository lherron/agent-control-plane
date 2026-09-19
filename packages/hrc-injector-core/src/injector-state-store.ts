import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import { HrcMailDeliveryRepository, WrkqLedgerCursorRepository } from 'hrc-store-sqlite'

import type { InjectorStateImport, InjectorStateStore } from './contracts.js'

export const INJECTOR_MOVED_TABLES = [
  'hrcmail_delivery_intents',
  'hrcmail_presentations',
  'hrcmail_birth_refusals',
  'hrcmail_delivery_expiries',
  'hrcmail_failure_notices',
  'wrkq_ledger_cursors',
] as const

type MovedTable = (typeof INJECTOR_MOVED_TABLES)[number]
type Row = Record<string, unknown>
export type TableParity = Readonly<{ count: number; maxKey: string | null }>
export type ImportMarker = Readonly<{ sourcePath: string; importedAt: string }>

const TABLE_KEYS: Record<MovedTable, string> = {
  hrcmail_delivery_intents: 'envelope_id',
  hrcmail_presentations: 'envelope_id || char(0) || runtime_id',
  hrcmail_birth_refusals: 'target_session_ref',
  hrcmail_delivery_expiries: 'envelope_id || char(0) || runtime_id',
  hrcmail_failure_notices: 'envelope_id || char(0) || target_session_ref',
  wrkq_ledger_cursors: 'stream',
}

/** Open the sole writable delivery store owned by the injector process. */
export function openInjectorStateStore(
  path: string,
  importFrom?: InjectorStateImport
): InjectorStateStore {
  mkdirSync(dirname(path), { recursive: true })
  const sqlite = new Database(path)
  sqlite.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
  try {
    ensureSchema(sqlite)
    if (importFrom !== undefined) importInjectorStateStore(sqlite, importFrom)
    return {
      mailDelivery: new HrcMailDeliveryRepository(sqlite),
      wrkqLedgerCursors: new WrkqLedgerCursorRepository(sqlite),
      close: () => sqlite.close(),
    }
  } catch (error) {
    sqlite.close()
    throw error
  }
}

/** Read the durable provenance marker that gates injector startup. */
export function readInjectorImportMarker(
  path: string,
  sourcePath?: string
): ImportMarker | undefined {
  if (!existsSync(path)) return undefined
  const db = new Database(path, { readonly: true })
  try {
    const row =
      sourcePath === undefined
        ? db
            .query<{ source_path: string; imported_at: string }, []>(
              'SELECT source_path, imported_at FROM injector_store_imports ORDER BY imported_at DESC LIMIT 1'
            )
            .get()
        : db
            .query<{ source_path: string; imported_at: string }, [string]>(
              'SELECT source_path, imported_at FROM injector_store_imports WHERE source_path = ?'
            )
            .get(sourcePath)
    return row === null ? undefined : { sourcePath: row.source_path, importedAt: row.imported_at }
  } finally {
    db.close()
  }
}

/**
 * Atomically import the private Phase-3 delivery database exactly once.
 * Every table is compared by row count and deterministic maximum key before
 * the marker is written, so no partial or unproven import can admit a writer.
 */
export function importInjectorStateStore(destination: Database, input: InjectorStateImport): void {
  const source = new Database(input.sourcePath, { readonly: true })
  try {
    const imported = destination
      .query<{ source_path: string }, [string]>(
        'SELECT source_path FROM injector_store_imports WHERE source_path = ?'
      )
      .get(input.sourcePath)
    if (imported !== null) return
    const operation = destination.transaction(() => {
      for (const table of INJECTOR_MOVED_TABLES) copyTable(source, destination, table)
      verifyParity(source, destination)
      destination
        .query('INSERT INTO injector_store_imports (source_path, imported_at) VALUES (?, ?)')
        .run(input.sourcePath, new Date().toISOString())
    })
    operation.immediate()
  } finally {
    source.close()
  }
}

export function injectorTableParity(path: string): Record<MovedTable, TableParity> {
  const db = new Database(path, { readonly: true })
  try {
    return Object.fromEntries(
      INJECTOR_MOVED_TABLES.map((table) => [table, parity(db, table)])
    ) as Record<MovedTable, TableParity>
  } finally {
    db.close()
  }
}

function ensureSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS injector_store_imports (
      source_path TEXT PRIMARY KEY,
      imported_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS hrcmail_delivery_intents (
      envelope_id TEXT PRIMARY KEY, target_session_ref TEXT NOT NULL,
      door TEXT NOT NULL CHECK (door IN ('steer', 'enqueue', 'preempt', 'invoke', 'launch')),
      form TEXT NOT NULL CHECK (form IN ('full', 'defer-retry', 'reminder')),
      presentation_id TEXT NOT NULL,
      runtime_id TEXT, submission_id TEXT, host_session_id TEXT,
      generation INTEGER CHECK (generation IS NULL OR generation >= 1),
      delivery_outcome TEXT, submitted_hrc_seq INTEGER NOT NULL, submitted_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, invocation_id TEXT, broker_after_seq INTEGER,
      uncertain_cause TEXT, uncertain_at TEXT, last_evidence_kind TEXT, last_evidence_at TEXT,
      terminal_envelope_cause TEXT, terminal_envelope_at TEXT, cleanup_outcome TEXT, cleanup_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_injector_intents_target ON hrcmail_delivery_intents(target_session_ref);
    CREATE INDEX IF NOT EXISTS idx_injector_intents_submission ON hrcmail_delivery_intents(submission_id);
    CREATE INDEX IF NOT EXISTS idx_injector_intents_runtime ON hrcmail_delivery_intents(runtime_id);
    CREATE TABLE IF NOT EXISTS hrcmail_presentations (
      envelope_id TEXT NOT NULL, runtime_id TEXT NOT NULL, target_session_ref TEXT NOT NULL,
      generation INTEGER CHECK (generation IS NULL OR generation >= 1),
      presentation_id TEXT NOT NULL, input_id TEXT, delivery_outcome TEXT NOT NULL,
      landing_hrc_seq INTEGER NOT NULL, landed_at TEXT NOT NULL, receipt_committed_at TEXT,
      turn_ended_at TEXT, reminder_armed_at TEXT, reminder_due_at TEXT,
      reminder_landing_hrc_seq INTEGER, reminder_landed_at TEXT, disposed_at TEXT, disposition TEXT,
      PRIMARY KEY (envelope_id, runtime_id)
    );
    CREATE INDEX IF NOT EXISTS idx_injector_presentations_runtime ON hrcmail_presentations(runtime_id) WHERE disposed_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_injector_presentations_target ON hrcmail_presentations(target_session_ref);
    CREATE INDEX IF NOT EXISTS idx_injector_presentations_reminder_due
      ON hrcmail_presentations(target_session_ref, reminder_due_at)
      WHERE reminder_due_at IS NOT NULL AND reminder_landing_hrc_seq IS NULL AND disposed_at IS NULL;
    CREATE TABLE IF NOT EXISTS hrcmail_birth_refusals (
      target_session_ref TEXT PRIMARY KEY, scope_ref TEXT NOT NULL,
      refusals INTEGER NOT NULL DEFAULT 0 CHECK (refusals >= 0),
      last_reason TEXT, resolved_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_injector_birth_refusals_open ON hrcmail_birth_refusals(resolved_at);
    CREATE TABLE IF NOT EXISTS hrcmail_delivery_expiries (
      envelope_id TEXT NOT NULL, runtime_id TEXT NOT NULL, expiries INTEGER NOT NULL,
      first_expired_at TEXT NOT NULL, last_expired_at TEXT NOT NULL, refusal_window_opened_at TEXT,
      PRIMARY KEY (envelope_id, runtime_id)
    );
    CREATE TABLE IF NOT EXISTS hrcmail_failure_notices (
      envelope_id TEXT NOT NULL, target_session_ref TEXT NOT NULL, notice TEXT NOT NULL,
      created_at TEXT NOT NULL, delivered_at TEXT,
      PRIMARY KEY (envelope_id, target_session_ref)
    );
    CREATE INDEX IF NOT EXISTS idx_injector_failure_notices_undelivered
      ON hrcmail_failure_notices(delivered_at, target_session_ref);
    CREATE TABLE IF NOT EXISTS wrkq_ledger_cursors (
      stream TEXT PRIMARY KEY, high_water INTEGER NOT NULL CHECK (high_water >= 0), updated_at TEXT NOT NULL
    );
  `)
}

function copyTable(source: Database, destination: Database, table: MovedTable): void {
  const rows = source.query(`SELECT * FROM ${table}`).all() as Row[]
  if (rows.length === 0) return
  const columns = Object.keys(rows[0] as Row)
  const insert = destination.query(
    `INSERT OR REPLACE INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
  )
  for (const row of rows) insert.run(...(columns.map((column) => row[column]) as never[]))
}

function parity(db: Database, table: MovedTable): TableParity {
  const row = db
    .query<{ count: number; max_key: string | null }, []>(
      `SELECT COUNT(*) AS count, MAX(${TABLE_KEYS[table]}) AS max_key FROM ${table}`
    )
    .get()
  return { count: row?.count ?? 0, maxKey: row?.max_key ?? null }
}

function verifyParity(source: Database, destination: Database): void {
  for (const table of INJECTOR_MOVED_TABLES) {
    const sourceParity = parity(source, table)
    const destinationParity = parity(destination, table)
    if (
      sourceParity.count !== destinationParity.count ||
      sourceParity.maxKey !== destinationParity.maxKey
    ) {
      throw new Error(
        `injector store import mismatch for ${table}: source ${JSON.stringify(sourceParity)}, destination ${JSON.stringify(destinationParity)}`
      )
    }
  }
}
