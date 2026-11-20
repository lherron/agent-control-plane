import type { SqliteDatabase } from './sqlite.js'

export function initializeSchema(sqlite: SqliteDatabase): void {
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

    CREATE TABLE IF NOT EXISTS mobile_timeline_projection_epochs (
      projection_epoch TEXT PRIMARY KEY,
      session_ref TEXT NOT NULL,
      host_session_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      contract_version INTEGER NOT NULL,
      hrc_ledger_incarnation_id TEXT NOT NULL,
      wrkq_ledger_incarnation_id TEXT NOT NULL,
      hrc_before_seq INTEGER NOT NULL,
      hrc_newest_seq INTEGER NOT NULL,
      message_before_seq INTEGER NOT NULL,
      message_newest_seq INTEGER NOT NULL,
      hrc_exhausted_before INTEGER NOT NULL CHECK (hrc_exhausted_before IN (0, 1)),
      wrkq_exhausted_before INTEGER NOT NULL CHECK (wrkq_exhausted_before IN (0, 1)),
      origin_timeline_ordinal INTEGER NOT NULL,
      min_timeline_ordinal INTEGER,
      max_timeline_ordinal INTEGER,
      active INTEGER NOT NULL CHECK (active IN (0, 1)),
      reset_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS mobile_timeline_projection_active_idx
      ON mobile_timeline_projection_epochs (session_ref, host_session_id, generation)
      WHERE active = 1;

    CREATE TABLE IF NOT EXISTS mobile_timeline_atoms (
      projection_epoch TEXT NOT NULL,
      atom_id TEXT NOT NULL,
      timeline_ordinal INTEGER NOT NULL,
      logical_frame_id TEXT NOT NULL,
      operation TEXT NOT NULL CHECK (operation IN ('append', 'replace')),
      source_kind TEXT NOT NULL CHECK (source_kind IN ('hrc', 'wrkq')),
      source_seq INTEGER NOT NULL,
      source_ts TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      prefix_state TEXT NOT NULL CHECK (prefix_state IN ('unknown', 'complete')),
      PRIMARY KEY (projection_epoch, atom_id),
      UNIQUE (projection_epoch, timeline_ordinal),
      FOREIGN KEY (projection_epoch) REFERENCES mobile_timeline_projection_epochs(projection_epoch)
    );

    CREATE INDEX IF NOT EXISTS mobile_timeline_atoms_ordinal_idx
      ON mobile_timeline_atoms (projection_epoch, timeline_ordinal);

    CREATE TABLE IF NOT EXISTS mobile_timeline_page_receipts (
      projection_epoch TEXT NOT NULL,
      request_digest TEXT NOT NULL,
      requested_limit INTEGER NOT NULL,
      response_contract_version INTEGER NOT NULL,
      boundary_timeline_ordinal INTEGER NOT NULL,
      atom_ids_json TEXT NOT NULL,
      timeline_ordinals_json TEXT NOT NULL,
      older_cursor TEXT,
      has_more_before INTEGER NOT NULL CHECK (has_more_before IN (0, 1)),
      high_water_hrc_seq INTEGER NOT NULL,
      high_water_message_seq INTEGER NOT NULL,
      reset_reason TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (projection_epoch, request_digest, requested_limit, response_contract_version),
      FOREIGN KEY (projection_epoch) REFERENCES mobile_timeline_projection_epochs(projection_epoch)
    );
  `)
}
