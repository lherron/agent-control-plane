import type { SqliteDatabase } from './sqlite.js'

type TableInfoRow = {
  name: string
  notnull?: number
}

type SqlMasterRow = {
  sql: string | null
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

function addActorColumns(sqlite: SqliteDatabase, tableName: string, columns: Set<string>): void {
  addColumnIfMissing(sqlite, tableName, columns, 'actor_kind', "TEXT NOT NULL DEFAULT ''")
  addColumnIfMissing(sqlite, tableName, columns, 'actor_id', "TEXT NOT NULL DEFAULT ''")
  addColumnIfMissing(sqlite, tableName, columns, 'actor_display_name', 'TEXT')
}

function backfillDefaultActors(sqlite: SqliteDatabase, tableName: string): void {
  sqlite.exec(`
    UPDATE ${tableName}
       SET actor_kind = CASE WHEN actor_kind = '' THEN 'system' ELSE actor_kind END,
           actor_id = CASE WHEN actor_id = '' THEN 'acp-local' ELSE actor_id END
     WHERE actor_kind = '' OR actor_id = ''
  `)
}

function migrateRunsActorColumns(sqlite: SqliteDatabase): void {
  const columns = listTableColumns(sqlite, 'runs')
  addActorColumns(sqlite, 'runs', columns)
  addColumnIfMissing(sqlite, 'runs', columns, 'after_hrc_seq', 'INTEGER')

  backfillDefaultActors(sqlite, 'runs')
}

function migrateInputAttemptsActorColumns(sqlite: SqliteDatabase): void {
  const columns = listTableColumns(sqlite, 'input_attempts')
  const hasLegacyActorAgentId = columns.has('actor_agent_id')

  addActorColumns(sqlite, 'input_attempts', columns)

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

  backfillDefaultActors(sqlite, 'input_attempts')
}

function migrateTransitionOutboxActorColumns(sqlite: SqliteDatabase): void {
  const columns = listTableColumns(sqlite, 'transition_outbox')
  addActorColumns(sqlite, 'transition_outbox', columns)
  backfillDefaultActors(sqlite, 'transition_outbox')
}

function migrateWorkflowObligationLifecycleColumns(sqlite: SqliteDatabase): void {
  const columns = listTableColumns(sqlite, 'workflow_obligations')
  addColumnIfMissing(sqlite, 'workflow_obligations', columns, 'waived_at', 'TEXT')
  addColumnIfMissing(sqlite, 'workflow_obligations', columns, 'waiver_reason', 'TEXT')
  addColumnIfMissing(sqlite, 'workflow_obligations', columns, 'waiver_evidence_refs_json', 'TEXT')
  addColumnIfMissing(sqlite, 'workflow_obligations', columns, 'cancelled_at', 'TEXT')
  addColumnIfMissing(sqlite, 'workflow_obligations', columns, 'cancel_reason', 'TEXT')
  addColumnIfMissing(sqlite, 'workflow_obligations', columns, 'expired_at', 'TEXT')
  addColumnIfMissing(sqlite, 'workflow_obligations', columns, 'expire_reason', 'TEXT')
}

function migrateWorkflowEventSourcingColumns(sqlite: SqliteDatabase): void {
  const columns = listTableColumns(sqlite, 'workflow_events')
  addColumnIfMissing(
    sqlite,
    'workflow_events',
    columns,
    'workflow_seq',
    'INTEGER NOT NULL DEFAULT 0'
  )
  addColumnIfMissing(
    sqlite,
    'workflow_events',
    columns,
    'schema_version',
    'INTEGER NOT NULL DEFAULT 1'
  )
  addColumnIfMissing(sqlite, 'workflow_events', columns, 'command_type', 'TEXT')
  addColumnIfMissing(sqlite, 'workflow_events', columns, 'command_hash', 'TEXT')
  addColumnIfMissing(sqlite, 'workflow_events', columns, 'causation_id', 'TEXT')
  addColumnIfMissing(sqlite, 'workflow_events', columns, 'correlation_id', 'TEXT')
  addColumnIfMissing(sqlite, 'workflow_events', columns, 'role', 'TEXT')
  addColumnIfMissing(sqlite, 'workflow_events', columns, 'authority', 'TEXT')
  addColumnIfMissing(
    sqlite,
    'workflow_events',
    columns,
    'result',
    "TEXT NOT NULL DEFAULT 'accepted'"
  )
  addColumnIfMissing(sqlite, 'workflow_events', columns, 'rejection_code', 'TEXT')
  addColumnIfMissing(sqlite, 'workflow_events', columns, 'event_hash', "TEXT NOT NULL DEFAULT ''")
  addColumnIfMissing(sqlite, 'workflow_events', columns, 'prev_hash', 'TEXT')
}

function getCreateTableSql(sqlite: SqliteDatabase, tableName: string): string {
  const row = sqlite
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(tableName) as SqlMasterRow | undefined

  return row?.sql ?? ''
}

function rebuildRunsForQueuedStatus(sqlite: SqliteDatabase): void {
  const createSql = getCreateTableSql(sqlite, 'runs')
  if (createSql.includes("'queued'")) {
    return
  }

  sqlite.exec(`
    PRAGMA foreign_keys = OFF;

    ALTER TABLE runs RENAME TO runs_legacy_input_admission;

    CREATE TABLE runs (
      run_id TEXT PRIMARY KEY,
      scope_ref TEXT NOT NULL,
      lane_ref TEXT NOT NULL,
      task_id TEXT,
      actor_kind TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      actor_display_name TEXT,
      status TEXT NOT NULL CHECK (status IN ('queued', 'pending', 'running', 'completed', 'failed', 'cancelled')),
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
      after_hrc_seq INTEGER,
      metadata_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    INSERT INTO runs (
      run_id,
      scope_ref,
      lane_ref,
      task_id,
      actor_kind,
      actor_id,
      actor_display_name,
      status,
      hrc_run_id,
      host_session_id,
      generation,
      runtime_id,
      transport,
      error_code,
      error_message,
      dispatch_fence_json,
      expected_host_session_id,
      expected_generation,
      follow_latest,
      after_hrc_seq,
      metadata_json,
      created_at,
      updated_at
    )
    SELECT run_id,
           scope_ref,
           lane_ref,
           task_id,
           actor_kind,
           actor_id,
           actor_display_name,
           status,
           hrc_run_id,
           host_session_id,
           generation,
           runtime_id,
           transport,
           error_code,
           error_message,
           dispatch_fence_json,
           expected_host_session_id,
           expected_generation,
           follow_latest,
           after_hrc_seq,
           metadata_json,
           created_at,
           updated_at
      FROM runs_legacy_input_admission;

    DROP TABLE runs_legacy_input_admission;

    CREATE INDEX IF NOT EXISTS runs_session_idx
      ON runs (scope_ref, lane_ref, created_at);

    PRAGMA foreign_keys = ON;
  `)
}

function rebuildInputAttemptsForNullableRun(sqlite: SqliteDatabase): void {
  const columns = sqlite.prepare('PRAGMA table_info(input_attempts)').all() as TableInfoRow[]
  const runIdColumn = columns.find((row) => row.name === 'run_id')
  if (runIdColumn?.notnull === 0) {
    return
  }

  const hasLegacyActorAgentId = columns.some((row) => row.name === 'actor_agent_id')
  const actorKindExpr = hasLegacyActorAgentId
    ? `CASE
         WHEN actor_kind IS NOT NULL AND actor_kind != '' THEN actor_kind
         WHEN actor_agent_id IS NOT NULL AND actor_agent_id != '' THEN 'agent'
         ELSE 'system'
       END`
    : `CASE WHEN actor_kind IS NOT NULL AND actor_kind != '' THEN actor_kind ELSE 'system' END`
  const actorIdExpr = hasLegacyActorAgentId
    ? `CASE
         WHEN actor_id IS NOT NULL AND actor_id != '' THEN actor_id
         WHEN actor_agent_id IS NOT NULL AND actor_agent_id != '' THEN actor_agent_id
         ELSE 'acp-local'
       END`
    : `CASE WHEN actor_id IS NOT NULL AND actor_id != '' THEN actor_id ELSE 'acp-local' END`

  sqlite.exec(`
    PRAGMA foreign_keys = OFF;

    ALTER TABLE input_attempts RENAME TO input_attempts_legacy_input_admission;

    CREATE TABLE input_attempts (
      input_attempt_id TEXT PRIMARY KEY,
      run_id TEXT,
      scope_ref TEXT NOT NULL,
      lane_ref TEXT NOT NULL,
      task_id TEXT,
      idempotency_key TEXT,
      fingerprint TEXT NOT NULL,
      content TEXT NOT NULL,
      actor_kind TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      actor_display_name TEXT,
      ${hasLegacyActorAgentId ? 'actor_agent_id TEXT,' : ''}
      metadata_json TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES runs(run_id)
    );

    INSERT INTO input_attempts (
      input_attempt_id,
      run_id,
      scope_ref,
      lane_ref,
      task_id,
      idempotency_key,
      fingerprint,
      content,
      actor_kind,
      actor_id,
      actor_display_name,
      ${hasLegacyActorAgentId ? 'actor_agent_id,' : ''}
      metadata_json,
      created_at
    )
    SELECT input_attempt_id,
           run_id,
           scope_ref,
           lane_ref,
           task_id,
           idempotency_key,
           fingerprint,
           content,
           ${actorKindExpr},
           ${actorIdExpr},
           actor_display_name,
           ${hasLegacyActorAgentId ? 'actor_agent_id,' : ''}
           metadata_json,
           created_at
      FROM input_attempts_legacy_input_admission;

    DROP TABLE input_attempts_legacy_input_admission;

    CREATE UNIQUE INDEX IF NOT EXISTS input_attempts_idempotency_unique
      ON input_attempts (scope_ref, lane_ref, idempotency_key)
      WHERE idempotency_key IS NOT NULL;

    CREATE INDEX IF NOT EXISTS input_attempts_run_idx
      ON input_attempts (run_id, created_at);

    PRAGMA foreign_keys = ON;
  `)
}

function rebuildInputAdmissionsForStatusConstraint(sqlite: SqliteDatabase): void {
  const createSql = getCreateTableSql(sqlite, 'input_admissions')
  if (createSql.includes('CHECK (status IN')) {
    return
  }

  sqlite.exec(`
    PRAGMA foreign_keys = OFF;

    ALTER TABLE input_admissions RENAME TO input_admissions_legacy_status_constraint;

    CREATE TABLE input_admissions (
      input_attempt_id TEXT PRIMARY KEY,
      admission_kind TEXT NOT NULL,
      intent_json TEXT NOT NULL,
      original_response_json TEXT NOT NULL,
      current_state_json TEXT,
      run_id TEXT,
      input_application_id TEXT,
      queue_item_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('rejected', 'queued', 'pending', 'accepted', 'started', 'failed')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (input_attempt_id) REFERENCES input_attempts(input_attempt_id),
      FOREIGN KEY (run_id) REFERENCES runs(run_id)
    );

    INSERT INTO input_admissions (
      input_attempt_id,
      admission_kind,
      intent_json,
      original_response_json,
      current_state_json,
      run_id,
      input_application_id,
      queue_item_id,
      status,
      created_at,
      updated_at
    )
    SELECT input_attempt_id,
           admission_kind,
           intent_json,
           original_response_json,
           current_state_json,
           run_id,
           input_application_id,
           queue_item_id,
           status,
           created_at,
           updated_at
      FROM input_admissions_legacy_status_constraint;

    DROP TABLE input_admissions_legacy_status_constraint;

    PRAGMA foreign_keys = ON;
  `)
}

function rebuildInputApplicationsForStatusConstraint(sqlite: SqliteDatabase): void {
  const createSql = getCreateTableSql(sqlite, 'input_applications')
  if (createSql.includes('CHECK (status IN')) {
    return
  }

  sqlite.exec(`
    PRAGMA foreign_keys = OFF;

    ALTER TABLE input_applications RENAME TO input_applications_legacy_status_constraint;

    CREATE TABLE input_applications (
      input_application_id TEXT PRIMARY KEY,
      input_attempt_id TEXT NOT NULL,
      target_run_id TEXT,
      hrc_run_id TEXT,
      host_session_id TEXT,
      generation INTEGER,
      runtime_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'applied', 'failed', 'ambiguous', 'cancelled')),
      delivery_attempts INTEGER NOT NULL DEFAULT 0,
      last_error_code TEXT,
      last_error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (input_attempt_id) REFERENCES input_attempts(input_attempt_id),
      FOREIGN KEY (target_run_id) REFERENCES runs(run_id)
    );

    INSERT INTO input_applications (
      input_application_id,
      input_attempt_id,
      target_run_id,
      hrc_run_id,
      host_session_id,
      generation,
      runtime_id,
      status,
      delivery_attempts,
      last_error_code,
      last_error_message,
      created_at,
      updated_at
    )
    SELECT input_application_id,
           input_attempt_id,
           target_run_id,
           hrc_run_id,
           host_session_id,
           generation,
           runtime_id,
           status,
           delivery_attempts,
           last_error_code,
           last_error_message,
           created_at,
           updated_at
      FROM input_applications_legacy_status_constraint;

    DROP TABLE input_applications_legacy_status_constraint;

    PRAGMA foreign_keys = ON;
  `)
}

function rebuildInputQueueForStatusConstraint(sqlite: SqliteDatabase): void {
  const createSql = getCreateTableSql(sqlite, 'input_queue')
  if (createSql.includes('CHECK (status IN')) {
    return
  }

  sqlite.exec(`
    PRAGMA foreign_keys = OFF;

    ALTER TABLE input_queue RENAME TO input_queue_legacy_status_constraint;

    CREATE TABLE input_queue (
      queue_item_id TEXT PRIMARY KEY,
      input_attempt_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      scope_ref TEXT NOT NULL,
      lane_ref TEXT NOT NULL,
      seq INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued', 'leased', 'dispatching', 'running', 'completed', 'failed', 'cancelled', 'expired')),
      reset_policy TEXT NOT NULL,
      expected_host_session_id TEXT,
      expected_generation INTEGER,
      not_before_at TEXT,
      leased_at TEXT,
      lease_owner TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error_code TEXT,
      last_error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (scope_ref, lane_ref, seq),
      FOREIGN KEY (input_attempt_id) REFERENCES input_attempts(input_attempt_id),
      FOREIGN KEY (run_id) REFERENCES runs(run_id)
    );

    INSERT INTO input_queue (
      queue_item_id,
      input_attempt_id,
      run_id,
      scope_ref,
      lane_ref,
      seq,
      status,
      reset_policy,
      expected_host_session_id,
      expected_generation,
      not_before_at,
      leased_at,
      lease_owner,
      attempts,
      last_error_code,
      last_error_message,
      created_at,
      updated_at
    )
    SELECT queue_item_id,
           input_attempt_id,
           run_id,
           scope_ref,
           lane_ref,
           seq,
           status,
           reset_policy,
           expected_host_session_id,
           expected_generation,
           not_before_at,
           leased_at,
           lease_owner,
           attempts,
           last_error_code,
           last_error_message,
           created_at,
           updated_at
      FROM input_queue_legacy_status_constraint;

    DROP TABLE input_queue_legacy_status_constraint;

    CREATE INDEX IF NOT EXISTS input_queue_dispatch_idx
      ON input_queue (status, not_before_at, scope_ref, lane_ref, seq);

    PRAGMA foreign_keys = ON;
  `)
}

/**
 * T-07728: v1 projections conflated an admitted atom's oldest source sequence
 * with the exclusive reverse frontier, so a producer head that no cohort
 * selected became permanently unreachable. Frontier state is not derivable from
 * a v1 row, so v1 epochs are retired rather than reinterpreted; the next open
 * mints a replacement epoch under the frontier contract.
 */
function migrateMobileTimelineSourceFrontiers(sqlite: SqliteDatabase): void {
  const columns = listTableColumns(sqlite, 'mobile_timeline_projection_epochs')
  if (columns.size === 0 || columns.has('hrc_before_seq')) return

  addColumnIfMissing(
    sqlite,
    'mobile_timeline_projection_epochs',
    columns,
    'contract_version',
    'INTEGER NOT NULL DEFAULT 1'
  )
  addColumnIfMissing(
    sqlite,
    'mobile_timeline_projection_epochs',
    columns,
    'hrc_before_seq',
    'INTEGER NOT NULL DEFAULT 0'
  )
  addColumnIfMissing(
    sqlite,
    'mobile_timeline_projection_epochs',
    columns,
    'message_before_seq',
    'INTEGER NOT NULL DEFAULT 0'
  )
  addColumnIfMissing(
    sqlite,
    'mobile_timeline_projection_epochs',
    columns,
    'origin_timeline_ordinal',
    'INTEGER NOT NULL DEFAULT 0'
  )

  sqlite.exec('UPDATE mobile_timeline_projection_epochs SET active = 0 WHERE contract_version < 2')

  for (const legacy of ['hrc_oldest_seq', 'message_oldest_seq']) {
    if (!columns.has(legacy)) continue
    sqlite.exec(`ALTER TABLE mobile_timeline_projection_epochs DROP COLUMN ${legacy}`)
  }
}

export function migrateLegacySchema(sqlite: SqliteDatabase): void {
  sqlite.transaction(() => {
    migrateRunsActorColumns(sqlite)
    migrateInputAttemptsActorColumns(sqlite)
    migrateTransitionOutboxActorColumns(sqlite)
    migrateWorkflowObligationLifecycleColumns(sqlite)
    migrateWorkflowEventSourcingColumns(sqlite)
    migrateMobileTimelineSourceFrontiers(sqlite)
  })()
  rebuildRunsForQueuedStatus(sqlite)
  rebuildInputAttemptsForNullableRun(sqlite)
  rebuildInputAdmissionsForStatusConstraint(sqlite)
  rebuildInputApplicationsForStatusConstraint(sqlite)
  rebuildInputQueueForStatusConstraint(sqlite)
}
