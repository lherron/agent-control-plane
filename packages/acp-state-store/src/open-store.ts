import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import { InputAdmissionRepo } from './repos/input-admission-repo.js'
import { InputApplicationRepo } from './repos/input-application-repo.js'
import { InputAttemptRepo } from './repos/input-attempt-repo.js'
import { InputQueueRepo } from './repos/input-queue-repo.js'
import { PbcContinuationJobsRepo } from './repos/pbc-continuation-jobs-repo.js'
import { RunRepo } from './repos/run-repo.js'
import { SessionAdmissionSequenceRepo } from './repos/session-admission-sequence-repo.js'
import type { RepoContext } from './repos/shared.js'
import { TransitionOutboxRepo } from './repos/transition-outbox-repo.js'
import { WorkflowRuntimeRepo } from './repos/workflow-runtime-repo.js'
import { WrkfParticipantCapturesRepo } from './repos/wrkf-participant-captures-repo.js'
import { WrkfRouteIdempotencyRepo } from './repos/wrkf-route-idempotency-repo.js'
import Database, { type SqliteDatabase } from './sqlite.js'

export interface OpenAcpStateStoreOptions {
  dbPath: string
}

export interface AcpStateStore {
  readonly sqlite: SqliteDatabase
  readonly runs: RunRepo
  readonly inputAttempts: InputAttemptRepo
  readonly inputAdmissions: InputAdmissionRepo
  readonly inputApplications: InputApplicationRepo
  readonly inputQueue: InputQueueRepo
  readonly sessionAdmissionSequences: SessionAdmissionSequenceRepo
  readonly transitionOutbox: TransitionOutboxRepo
  readonly workflowRuntime: WorkflowRuntimeRepo
  readonly wrkfRouteIdempotency: WrkfRouteIdempotencyRepo
  readonly wrkfParticipantCaptures: WrkfParticipantCapturesRepo
  readonly pbcContinuationJobs: PbcContinuationJobsRepo
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

    CREATE INDEX IF NOT EXISTS runs_session_idx
      ON runs (scope_ref, lane_ref, created_at);

    CREATE TABLE IF NOT EXISTS input_attempts (
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
      metadata_json TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES runs(run_id)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS input_attempts_idempotency_unique
      ON input_attempts (scope_ref, lane_ref, idempotency_key)
      WHERE idempotency_key IS NOT NULL;

    CREATE INDEX IF NOT EXISTS input_attempts_run_idx
      ON input_attempts (run_id, created_at);

    CREATE TABLE IF NOT EXISTS input_admissions (
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

    CREATE TABLE IF NOT EXISTS input_applications (
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

    CREATE TABLE IF NOT EXISTS input_queue (
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

    CREATE INDEX IF NOT EXISTS input_queue_dispatch_idx
      ON input_queue (status, not_before_at, scope_ref, lane_ref, seq);

    CREATE TABLE IF NOT EXISTS session_admission_sequence (
      scope_ref TEXT NOT NULL,
      lane_ref TEXT NOT NULL,
      next_seq INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (scope_ref, lane_ref)
    );

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

    CREATE TABLE IF NOT EXISTS workflow_definitions (
      id TEXT NOT NULL,
      version INTEGER NOT NULL,
      hash TEXT NOT NULL,
      definition_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (id, version)
    );

    CREATE TABLE IF NOT EXISTS workflow_tasks (
      task_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      workflow_version INTEGER NOT NULL,
      workflow_hash TEXT NOT NULL,
      state_json TEXT NOT NULL,
      version INTEGER NOT NULL,
      goal TEXT NOT NULL,
      risk TEXT,
      facts_json TEXT,
      role_bindings_json TEXT NOT NULL,
      supervisor_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workflow_evidence (
      evidence_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      ref TEXT NOT NULL,
      summary TEXT,
      data_json TEXT,
      actor_json TEXT,
      role TEXT,
      run_id TEXT,
      participant_run_id TEXT,
      supervisor_run_id TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workflow_obligations (
      obligation_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      owner_role TEXT,
      summary TEXT NOT NULL,
      blocking INTEGER NOT NULL CHECK (blocking IN (0, 1)),
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      satisfied_at TEXT,
      satisfaction_evidence_ids_json TEXT,
      waived_at TEXT,
      waiver_reason TEXT,
      waiver_evidence_refs_json TEXT,
      cancelled_at TEXT,
      cancel_reason TEXT,
      expired_at TEXT,
      expire_reason TEXT
    );

    CREATE TABLE IF NOT EXISTS workflow_events (
      event_id TEXT PRIMARY KEY,
      workflow_seq INTEGER NOT NULL DEFAULT 0,
      schema_version INTEGER NOT NULL DEFAULT 1,
      task_id TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      workflow_version INTEGER NOT NULL,
      workflow_hash TEXT NOT NULL,
      type TEXT NOT NULL,
      command_type TEXT,
      command_hash TEXT,
      causation_id TEXT,
      correlation_id TEXT,
      actor_json TEXT NOT NULL,
      role TEXT,
      authority TEXT,
      run_id TEXT,
      supervisor_run_id TEXT,
      participant_run_id TEXT,
      observed_task_version INTEGER NOT NULL,
      next_task_version INTEGER,
      context_hash TEXT,
      idempotency_key TEXT NOT NULL,
      result TEXT NOT NULL DEFAULT 'accepted',
      rejection_code TEXT,
      payload_json TEXT NOT NULL,
      event_hash TEXT NOT NULL DEFAULT '',
      prev_hash TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workflow_hrc_run_maps (
      map_id TEXT PRIMARY KEY,
      workflow_task_id TEXT NOT NULL,
      participant_run_id TEXT,
      supervisor_run_id TEXT,
      hrc_run_id TEXT NOT NULL,
      runtime_id TEXT,
      launch_id TEXT,
      host_session_id TEXT,
      scope_ref TEXT,
      lane_ref TEXT,
      generation INTEGER,
      created_at TEXT NOT NULL,
      source TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workflow_effect_intents (
      effect_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      source_event_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workflow_participant_runs (
      run_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      workflow_json TEXT NOT NULL,
      actor_json TEXT NOT NULL,
      role TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'launched',
      parent_supervisor_run_id TEXT,
      task_version_at_start INTEGER NOT NULL,
      context_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workflow_supervisor_runs (
      run_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      workflow_json TEXT NOT NULL,
      supervisor_json TEXT NOT NULL,
      autonomy TEXT NOT NULL,
      capabilities_json TEXT NOT NULL,
      harness_json TEXT,
      task_version_at_start INTEGER NOT NULL,
      context_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      paused INTEGER NOT NULL DEFAULT 0,
      paused_reason TEXT
    );

    CREATE TABLE IF NOT EXISTS workflow_anomalies (
      anomaly_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      workflow_json TEXT NOT NULL,
      supervisor_run_id TEXT,
      category TEXT NOT NULL,
      state_at_observation_json TEXT NOT NULL,
      task_version INTEGER NOT NULL,
      summary TEXT NOT NULL,
      proposed_recovery TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workflow_patch_proposals (
      proposal_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      base_workflow_json TEXT NOT NULL,
      proposed_version INTEGER,
      source_anomaly_ids_json TEXT NOT NULL,
      patch_kind TEXT NOT NULL,
      patch_json TEXT NOT NULL,
      rationale_summary TEXT NOT NULL,
      status TEXT NOT NULL,
      created_by_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workflow_idempotency_records (
      idempotency_key TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workflow_context_hashes (
      task_id TEXT NOT NULL,
      context_hash TEXT NOT NULL,
      PRIMARY KEY (task_id, context_hash)
    );

    CREATE TABLE IF NOT EXISTS workflow_runtime_meta (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS wrkf_route_idempotency (
      route TEXT NOT NULL,
      task_id TEXT NOT NULL,
      actor_hash TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      body_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
      response_json TEXT,
      error_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (route, task_id, actor_hash, idempotency_key)
    );

    CREATE TABLE IF NOT EXISTS wrkf_participant_captures (
      capture_key TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      workflow_ref TEXT NOT NULL,
      wrkf_run_id TEXT NOT NULL,
      body_hash TEXT NOT NULL,
      evidence_ids_json TEXT NOT NULL,
      obligation_ids_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'completed')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pbc_continuation_jobs (
      job_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      workflow_ref TEXT NOT NULL,
      revision_at_admission TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
      attempt INTEGER NOT NULL DEFAULT 0,
      lease_owner TEXT,
      lease_expires_at TEXT,
      stop_reason TEXT,
      result_json TEXT,
      error_json TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      updated_at TEXT NOT NULL,
      UNIQUE (task_id, revision_at_admission, idempotency_key)
    );

    CREATE INDEX IF NOT EXISTS pbc_continuation_jobs_status_idx
      ON pbc_continuation_jobs (status, created_at);
  `)
}

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

function migrateRunsActorColumns(sqlite: SqliteDatabase): void {
  const columns = listTableColumns(sqlite, 'runs')
  addColumnIfMissing(sqlite, 'runs', columns, 'actor_kind', "TEXT NOT NULL DEFAULT ''")
  addColumnIfMissing(sqlite, 'runs', columns, 'actor_id', "TEXT NOT NULL DEFAULT ''")
  addColumnIfMissing(sqlite, 'runs', columns, 'actor_display_name', 'TEXT')
  addColumnIfMissing(sqlite, 'runs', columns, 'after_hrc_seq', 'INTEGER')

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

function migrateLegacySchema(sqlite: SqliteDatabase): void {
  sqlite.transaction(() => {
    migrateRunsActorColumns(sqlite)
    migrateInputAttemptsActorColumns(sqlite)
    migrateTransitionOutboxActorColumns(sqlite)
    migrateWorkflowObligationLifecycleColumns(sqlite)
    migrateWorkflowEventSourcingColumns(sqlite)
  })()
  rebuildRunsForQueuedStatus(sqlite)
  rebuildInputAttemptsForNullableRun(sqlite)
  rebuildInputAdmissionsForStatusConstraint(sqlite)
  rebuildInputApplicationsForStatusConstraint(sqlite)
  rebuildInputQueueForStatusConstraint(sqlite)
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
    inputAdmissions: new InputAdmissionRepo(context),
    inputApplications: new InputApplicationRepo(context),
    inputQueue: new InputQueueRepo(context),
    sessionAdmissionSequences: new SessionAdmissionSequenceRepo(context),
    transitionOutbox: new TransitionOutboxRepo(context),
    workflowRuntime: new WorkflowRuntimeRepo(context),
    wrkfRouteIdempotency: new WrkfRouteIdempotencyRepo(context),
    wrkfParticipantCaptures: new WrkfParticipantCapturesRepo(context),
    pbcContinuationJobs: new PbcContinuationJobsRepo(context),
    runInTransaction<T>(fn: (activeStore: AcpStateStore) => T): T {
      return sqlite.transaction(() => fn(store))()
    },
    close(): void {
      sqlite.close()
    },
  } satisfies AcpStateStore

  return store
}
