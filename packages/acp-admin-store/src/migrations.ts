import type { SqliteDatabase } from './sqlite.js'

type MigrationRow = {
  id: string
}

export type AdminStoreMigration = {
  id: string
  sql: string
}

export const adminStoreMigrations: readonly AdminStoreMigration[] = [
  {
    id: '001_initial',
    sql: `
      CREATE TABLE IF NOT EXISTS agents (
        agent_id TEXT PRIMARY KEY,
        display_name TEXT,
        status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        actor_stamp TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS projects (
        project_id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        default_agent_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        actor_stamp TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memberships (
        project_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('coordinator', 'implementer', 'tester', 'observer')),
        created_at TEXT NOT NULL,
        actor_stamp TEXT NOT NULL,
        PRIMARY KEY (project_id, agent_id)
      );

      CREATE INDEX IF NOT EXISTS memberships_project_created_idx
        ON memberships (project_id, created_at, agent_id);

      CREATE TABLE IF NOT EXISTS interface_identities (
        identity_id TEXT PRIMARY KEY,
        gateway_id TEXT NOT NULL,
        external_id TEXT NOT NULL,
        display_name TEXT,
        linked_agent_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        actor_stamp TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS interface_identities_gateway_external_unique
        ON interface_identities (gateway_id, external_id);

      CREATE TABLE IF NOT EXISTS system_events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        actor_stamp TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS system_events_project_idx
        ON system_events (project_id, occurred_at, event_id);

      CREATE INDEX IF NOT EXISTS system_events_kind_idx
        ON system_events (kind, occurred_at, event_id);

      CREATE INDEX IF NOT EXISTS system_events_occurred_at_idx
        ON system_events (occurred_at, event_id);
    `,
  },
  {
    id: '002_heartbeats',
    sql: `
      CREATE TABLE IF NOT EXISTS agent_heartbeats (
        agent_id TEXT PRIMARY KEY,
        last_heartbeat_at TEXT NOT NULL,
        source TEXT,
        last_note TEXT,
        status TEXT NOT NULL CHECK (status IN ('alive', 'stale'))
      );
    `,
  },
  {
    id: '003_placement_metadata',
    sql: `
      ALTER TABLE agents ADD COLUMN home_dir TEXT;
      ALTER TABLE projects ADD COLUMN root_dir TEXT;
    `,
  },
  {
    id: '004_heartbeat_target',
    sql: `
      ALTER TABLE agent_heartbeats ADD COLUMN target_scope_ref TEXT;
      ALTER TABLE agent_heartbeats ADD COLUMN target_lane_ref TEXT;
    `,
  },
  {
    id: '005_agent_profile',
    sql: `
      ALTER TABLE agents ADD COLUMN profile_display_color TEXT;
      ALTER TABLE agents ADD COLUMN profile_monogram TEXT;
      ALTER TABLE agents ADD COLUMN profile_avatar_url TEXT;
      ALTER TABLE agents ADD COLUMN profile_tagline TEXT;
      ALTER TABLE agents ADD COLUMN profile_role TEXT;
      ALTER TABLE agents ADD COLUMN profile_default_model TEXT;
      ALTER TABLE agents ADD COLUMN profile_vibe TEXT;
      ALTER TABLE agents ADD COLUMN profile_specialties TEXT;
    `,
  },
  {
    id: '006_membership_agent_project_lookup',
    sql: `
      CREATE INDEX IF NOT EXISTS memberships_agent_project_idx
        ON memberships (agent_id, project_id);

      CREATE INDEX IF NOT EXISTS projects_created_project_idx
        ON projects (created_at, project_id);
    `,
  },
]

function ensureMigrationTable(sqlite: SqliteDatabase): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS acp_admin_store_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `)
}

export function listAppliedAdminStoreMigrations(sqlite: SqliteDatabase): string[] {
  ensureMigrationTable(sqlite)
  return (
    sqlite
      .prepare('SELECT id FROM acp_admin_store_migrations ORDER BY id ASC')
      .all() as MigrationRow[]
  ).map((row) => row.id)
}

export function runAdminStoreMigrations(sqlite: SqliteDatabase): void {
  ensureMigrationTable(sqlite)
  const applied = new Set(listAppliedAdminStoreMigrations(sqlite))

  sqlite.transaction((pending: readonly AdminStoreMigration[]) => {
    for (const migration of pending) {
      if (applied.has(migration.id)) {
        continue
      }

      if (migration.sql.trim().length > 0) {
        sqlite.exec(migration.sql)
      }
      sqlite
        .prepare('INSERT INTO acp_admin_store_migrations (id, applied_at) VALUES (?, ?)')
        .run(migration.id, new Date().toISOString())
    }
  })(adminStoreMigrations)
}
