import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { SqliteDatabase } from './sqlite.js'
import Database from './sqlite.js'
import type { JobsStoreMigration } from './store-contracts.js'

type MigrationRow = {
  id: string
}

export const jobsStoreMigrations: readonly JobsStoreMigration[] = [
  {
    id: '001_initial',
    sql: `
      CREATE TABLE IF NOT EXISTS jobs (
        job_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        scope_ref TEXT NOT NULL,
        lane_ref TEXT NOT NULL,
        schedule_cron TEXT NOT NULL,
        schedule_window_start TEXT,
        schedule_window_end TEXT,
        schedule_json TEXT NOT NULL,
        input_json TEXT NOT NULL,
        disabled INTEGER NOT NULL DEFAULT 0,
        last_fire_at TEXT,
        next_fire_at TEXT,
        actor_stamp TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT
      );

      CREATE INDEX IF NOT EXISTS jobs_project_id_idx ON jobs (project_id);
      CREATE INDEX IF NOT EXISTS jobs_next_fire_at_idx ON jobs (next_fire_at) WHERE archived_at IS NULL AND disabled = 0;

      CREATE TABLE IF NOT EXISTS job_runs (
        job_run_id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        triggered_at TEXT NOT NULL,
        triggered_by TEXT NOT NULL,
        status TEXT NOT NULL,
        input_attempt_id TEXT,
        run_id TEXT,
        error_code TEXT,
        error_message TEXT,
        lease_owner TEXT,
        lease_expires_at TEXT,
        claimed_at TEXT,
        dispatched_at TEXT,
        completed_at TEXT,
        actor_stamp TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS job_runs_job_id_idx ON job_runs (job_id, triggered_at DESC);
      CREATE INDEX IF NOT EXISTS job_runs_triggered_at_idx ON job_runs (triggered_at);
      CREATE INDEX IF NOT EXISTS job_runs_claimable_idx ON job_runs (status, triggered_at, lease_expires_at);
    `,
  },
  {
    id: '002_actor_columns',
    sql: `
      ALTER TABLE jobs ADD COLUMN actor_kind TEXT;
      ALTER TABLE jobs ADD COLUMN actor_id TEXT;
      ALTER TABLE jobs ADD COLUMN actor_display_name TEXT;
      UPDATE jobs
         SET actor_kind = COALESCE(actor_kind, 'system'),
             actor_id = COALESCE(actor_id, actor_stamp)
       WHERE actor_kind IS NULL OR actor_id IS NULL;

      ALTER TABLE job_runs ADD COLUMN actor_kind TEXT;
      ALTER TABLE job_runs ADD COLUMN actor_id TEXT;
      ALTER TABLE job_runs ADD COLUMN actor_display_name TEXT;
      UPDATE job_runs
         SET actor_kind = COALESCE(actor_kind, 'system'),
             actor_id = COALESCE(actor_id, actor_stamp)
       WHERE actor_kind IS NULL OR actor_id IS NULL;
    `,
  },
  {
    id: '003_job_flow',
    sql: `
      ALTER TABLE jobs ADD COLUMN flow_json TEXT;

      CREATE TABLE IF NOT EXISTS job_step_runs (
        job_run_id TEXT NOT NULL,
        phase TEXT NOT NULL,
        step_id TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        input_attempt_id TEXT,
        run_id TEXT,
        result_block TEXT,
        result_json TEXT,
        error_code TEXT,
        error_message TEXT,
        started_at TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (job_run_id, phase, step_id, attempt),
        FOREIGN KEY (job_run_id) REFERENCES job_runs(job_run_id)
      );

      CREATE INDEX IF NOT EXISTS job_step_runs_job_run_idx
        ON job_step_runs (job_run_id, phase, created_at, step_id);

      CREATE INDEX IF NOT EXISTS job_step_runs_run_id_idx
        ON job_step_runs (run_id)
        WHERE run_id IS NOT NULL;
    `,
  },
  {
    id: '004_job_slug_description',
    sql: `
      ALTER TABLE jobs ADD COLUMN slug TEXT;
      ALTER TABLE jobs ADD COLUMN description TEXT;
      UPDATE jobs SET slug = job_id WHERE slug IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS jobs_project_slug_idx
        ON jobs (project_id, slug)
        WHERE archived_at IS NULL;
    `,
  },
  {
    id: '005_job_trigger_union_and_event_inbox',
    sql: `
      -- 1. Add the trigger union columns and backfill existing rows as schedule
      --    triggers (the only trigger that existed before this migration).
      ALTER TABLE jobs ADD COLUMN trigger_kind TEXT;
      ALTER TABLE jobs ADD COLUMN trigger_json TEXT;
      UPDATE jobs
         SET trigger_kind = 'schedule',
             trigger_json = json_set(COALESCE(NULLIF(schedule_json, ''), '{}'), '$.kind', 'schedule')
       WHERE trigger_kind IS NULL;

      -- 2. Rebuild jobs to drop NOT NULL from schedule_cron/schedule_json (which
      --    are now schedule-only denormalized indexes) and make trigger_kind /
      --    trigger_json NOT NULL. No other table holds a FK to jobs.
      CREATE TABLE jobs_new (
        job_id TEXT PRIMARY KEY,
        slug TEXT,
        description TEXT,
        project_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        scope_ref TEXT NOT NULL,
        lane_ref TEXT NOT NULL,
        trigger_kind TEXT NOT NULL,
        trigger_json TEXT NOT NULL,
        schedule_cron TEXT,
        schedule_window_start TEXT,
        schedule_window_end TEXT,
        schedule_json TEXT,
        input_json TEXT NOT NULL,
        flow_json TEXT,
        disabled INTEGER NOT NULL DEFAULT 0,
        last_fire_at TEXT,
        next_fire_at TEXT,
        actor_kind TEXT,
        actor_id TEXT,
        actor_display_name TEXT,
        actor_stamp TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT
      );
      INSERT INTO jobs_new (
        job_id, slug, description, project_id, agent_id, scope_ref, lane_ref,
        trigger_kind, trigger_json, schedule_cron, schedule_window_start,
        schedule_window_end, schedule_json, input_json, flow_json, disabled,
        last_fire_at, next_fire_at, actor_kind, actor_id, actor_display_name,
        actor_stamp, created_at, updated_at, archived_at
      )
      SELECT
        job_id, slug, description, project_id, agent_id, scope_ref, lane_ref,
        trigger_kind, trigger_json, schedule_cron, schedule_window_start,
        schedule_window_end, schedule_json, input_json, flow_json, disabled,
        last_fire_at, next_fire_at, actor_kind, actor_id, actor_display_name,
        actor_stamp, created_at, updated_at, archived_at
      FROM jobs;
      DROP TABLE jobs;
      ALTER TABLE jobs_new RENAME TO jobs;

      CREATE INDEX IF NOT EXISTS jobs_project_id_idx ON jobs (project_id);
      CREATE INDEX IF NOT EXISTS jobs_next_fire_at_idx
        ON jobs (next_fire_at) WHERE archived_at IS NULL AND disabled = 0;
      CREATE UNIQUE INDEX IF NOT EXISTS jobs_project_slug_idx
        ON jobs (project_id, slug) WHERE archived_at IS NULL;
      CREATE INDEX IF NOT EXISTS jobs_trigger_kind_idx
        ON jobs (trigger_kind) WHERE archived_at IS NULL AND disabled = 0;

      -- 3. Resolved-action snapshot + source provenance on job_runs (event runs).
      ALTER TABLE job_runs ADD COLUMN resolved_scope_ref TEXT;
      ALTER TABLE job_runs ADD COLUMN resolved_lane_ref TEXT;
      ALTER TABLE job_runs ADD COLUMN resolved_input_json TEXT;
      ALTER TABLE job_runs ADD COLUMN source_json TEXT;

      -- 4. event_inbox: durable, idempotent receipt of webhook events with
      --    claim/retry semantics. One event -> 0..N JobRuns.
      CREATE TABLE IF NOT EXISTS event_inbox (
        event_id TEXT PRIMARY KEY,
        event_seq INTEGER NOT NULL,
        source TEXT NOT NULL DEFAULT 'wrkq',
        event TEXT NOT NULL,
        occurred_at TEXT,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        lease_owner TEXT,
        lease_expires_at TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        received_at TEXT NOT NULL,
        processed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS event_inbox_drain_idx ON event_inbox (status, event_seq);

      -- 5. event_job_matches: per-(event,job) outcome ledger. PK enforces mint
      --    idempotency (drain-retry safe) and doubles as the skip ledger.
      CREATE TABLE IF NOT EXISTS event_job_matches (
        source_event_id TEXT NOT NULL,
        job_id TEXT NOT NULL,
        event_seq INTEGER NOT NULL,
        outcome TEXT NOT NULL,
        reason TEXT,
        job_run_id TEXT,
        target_task_id TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (source_event_id, job_id)
      );
      CREATE INDEX IF NOT EXISTS event_job_matches_cooldown_idx
        ON event_job_matches (job_id, target_task_id, created_at)
        WHERE outcome = 'minted';
      CREATE INDEX IF NOT EXISTS event_job_matches_event_idx
        ON event_job_matches (source_event_id);
    `,
  },
  {
    id: '006_managed_resource_provenance_jobs',
    sql: `
      CREATE TABLE IF NOT EXISTS managed_resource_provenance_jobs (
        provenance_id TEXT PRIMARY KEY,
        projection_id TEXT NOT NULL,
        projection_pk TEXT NOT NULL,
        projection_row_fingerprint TEXT,
        projection_row_updated_at TEXT,
        job_id TEXT NOT NULL,
        source_owner_scope_ref TEXT NOT NULL,
        resource_name TEXT NOT NULL,
        source_path TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        desired_projection_hash TEXT NOT NULL,
        desired_projection_json TEXT NOT NULL,
        resource_kind TEXT NOT NULL CHECK (resource_kind IN ('scheduled-job', 'event-hook')),
        managed_by TEXT NOT NULL DEFAULT 'agent-directory',
        source_version INTEGER NOT NULL DEFAULT 1,
        state TEXT NOT NULL CHECK (state IN ('active', 'disabled')),
        applied_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS managed_resource_provenance_jobs_projection_id_unique
        ON managed_resource_provenance_jobs (projection_id);

      CREATE UNIQUE INDEX IF NOT EXISTS managed_resource_provenance_jobs_projection_pk_unique
        ON managed_resource_provenance_jobs (projection_pk);

      CREATE UNIQUE INDEX IF NOT EXISTS managed_resource_provenance_jobs_source_identity_unique
        ON managed_resource_provenance_jobs (
          managed_by,
          source_owner_scope_ref,
          resource_kind,
          resource_name
        );

      CREATE UNIQUE INDEX IF NOT EXISTS managed_resource_provenance_jobs_job_id_unique
        ON managed_resource_provenance_jobs (job_id);
    `,
  },
  {
    id: '007_job_output_sinks',
    sql: `
      ALTER TABLE jobs ADD COLUMN output_json TEXT;
      ALTER TABLE job_runs ADD COLUMN output_json TEXT;

      CREATE TABLE IF NOT EXISTS job_output_sink_attempts (
        job_run_id TEXT NOT NULL,
        sink_index INTEGER NOT NULL,
        sink_fingerprint TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        last_attempt_at TEXT,
        delivered_at TEXT,
        delivery_request_id TEXT,
        payload_hash TEXT,
        body_hash TEXT,
        last_error TEXT,
        response_status INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (job_run_id, sink_index, sink_fingerprint),
        FOREIGN KEY (job_run_id) REFERENCES job_runs(job_run_id)
      );

      CREATE INDEX IF NOT EXISTS job_output_sink_attempts_retry_idx
        ON job_output_sink_attempts (status, next_attempt_at, updated_at);
    `,
  },
  {
    id: '008_job_run_retry_backoff',
    sql: `
      ALTER TABLE job_runs ADD COLUMN retry_attempts INTEGER;
      ALTER TABLE job_runs ADD COLUMN next_attempt_at TEXT;
      ALTER TABLE job_runs ADD COLUMN last_retry_error TEXT;

      CREATE INDEX IF NOT EXISTS job_runs_retry_idx
        ON job_runs (status, next_attempt_at)
        WHERE next_attempt_at IS NOT NULL;
    `,
  },
  {
    id: '009_job_step_branch_taken',
    sql: `
      ALTER TABLE job_step_runs ADD COLUMN branch_taken_json TEXT;
    `,
  },
  {
    id: '010_job_execution_owner_set',
    sql: `
      ALTER TABLE jobs ADD COLUMN execution_nodes_json TEXT;
    `,
  },
  {
    id: '011_job_run_execution_node',
    sql: `
      ALTER TABLE job_runs ADD COLUMN execution_node_id TEXT;

      CREATE INDEX IF NOT EXISTS job_runs_execution_node_idx
        ON job_runs (execution_node_id, status);
    `,
  },
]

function ensureMigrationTable(sqlite: SqliteDatabase): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS acp_jobs_store_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `)
}

export function createSqliteDatabase(dbPath: string): SqliteDatabase {
  if (dbPath !== '' && dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true })
  }

  const sqlite = new Database(dbPath)
  // busy_timeout first: journal_mode takes a lock, and without a timeout a
  // concurrent writer or closing checkpoint fails the open with SQLITE_BUSY.
  sqlite.exec('PRAGMA busy_timeout = 5000;')
  sqlite.exec('PRAGMA journal_mode = WAL;')
  sqlite.exec('PRAGMA foreign_keys = ON;')
  return sqlite
}

export function listAppliedJobsStoreMigrations(sqlite: SqliteDatabase): string[] {
  ensureMigrationTable(sqlite)
  return (
    sqlite
      .prepare('SELECT id FROM acp_jobs_store_migrations ORDER BY id ASC')
      .all() as MigrationRow[]
  ).map((row) => row.id)
}

export function runJobsStoreMigrations(sqlite: SqliteDatabase): void {
  ensureMigrationTable(sqlite)
  const applied = new Set(listAppliedJobsStoreMigrations(sqlite))

  sqlite.transaction((pending: readonly JobsStoreMigration[]) => {
    for (const migration of pending) {
      if (applied.has(migration.id)) {
        continue
      }

      if (migration.sql.trim().length > 0) {
        sqlite.exec(migration.sql)
      }
      sqlite
        .prepare('INSERT INTO acp_jobs_store_migrations (id, applied_at) VALUES (?, ?)')
        .run(migration.id, new Date().toISOString())
    }
  })(jobsStoreMigrations)
}
