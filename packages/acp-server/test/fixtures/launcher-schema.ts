import type { Database } from 'bun:sqlite'

export function createLauncherRunTables(db: Database): void {
  db.exec(`
      CREATE TABLE runs (
        run_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        error_code TEXT,
        error_message TEXT
      );
      CREATE TABLE events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT,
        event_kind TEXT NOT NULL,
        event_json TEXT NOT NULL
      );
  `)
}

export function createLauncherRuntimeTables(db: Database): void {
  db.exec(`
      CREATE TABLE continuities (
        scope_ref TEXT NOT NULL,
        lane_ref TEXT NOT NULL,
        active_host_session_id TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (scope_ref, lane_ref)
      );
      CREATE TABLE runtimes (
        runtime_id TEXT PRIMARY KEY,
        host_session_id TEXT NOT NULL,
        transport TEXT NOT NULL,
        status TEXT NOT NULL,
        tmux_json TEXT,
        updated_at TEXT NOT NULL
      );
  `)
}

export function createLauncherEventTable(db: Database, correlation: 'run' | 'session'): void {
  if (correlation === 'run') {
    db.exec(`
      CREATE TABLE hrc_events (
        hrc_seq INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT,
        event_kind TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
    `)
  } else {
    db.exec(`
      CREATE TABLE hrc_events (
        hrc_seq INTEGER PRIMARY KEY AUTOINCREMENT,
        host_session_id TEXT NOT NULL,
        scope_ref TEXT NOT NULL,
        lane_ref TEXT NOT NULL,
        event_kind TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
    `)
  }
}
