CREATE TABLE IF NOT EXISTS coordination_events (
  event_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  actor TEXT NULL,
  semantic_session TEXT NULL,
  content TEXT NULL,
  source TEXT NULL,
  meta TEXT NULL,
  idempotency_key TEXT NULL,
  UNIQUE(project_id, seq)
);

CREATE TABLE IF NOT EXISTS coordination_event_participants (
  event_id TEXT NOT NULL REFERENCES coordination_events(event_id) ON DELETE CASCADE,
  participant TEXT NOT NULL,
  PRIMARY KEY (event_id, participant)
);

CREATE TABLE IF NOT EXISTS coordination_event_links (
  event_id TEXT PRIMARY KEY REFERENCES coordination_events(event_id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  task_id TEXT NULL,
  run_id TEXT NULL,
  session_id TEXT NULL,
  delivery_request_id TEXT NULL,
  artifact_refs TEXT NULL,
  conversation_thread_id TEXT NULL,
  conversation_turn_id TEXT NULL
);

CREATE TABLE IF NOT EXISTS handoffs (
  handoff_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL REFERENCES coordination_events(event_id),
  task_id TEXT NULL,
  from_participant TEXT NULL,
  to_participant TEXT NULL,
  target_session TEXT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('review', 'approval', 'delivery', 'tool-wait', 'human-wait', 'blocked')),
  reason TEXT NULL,
  state TEXT NOT NULL CHECK (state IN ('open', 'accepted', 'completed', 'cancelled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS wake_requests (
  wake_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL REFERENCES coordination_events(event_id),
  session_ref TEXT NOT NULL,
  reason TEXT NULL,
  dedupe_key TEXT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'leased', 'consumed', 'cancelled', 'expired')),
  leased_until TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS local_dispatch_attempts (
  attempt_id TEXT PRIMARY KEY,
  wake_id TEXT NULL REFERENCES wake_requests(wake_id) ON DELETE CASCADE,
  target TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projection_cursors (
  projection_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  last_seq INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (projection_id, project_id)
);

CREATE TABLE IF NOT EXISTS project_seq_counters (
  project_id TEXT PRIMARY KEY,
  last_seq INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS coord_events_seq ON coordination_events(project_id, seq);
CREATE UNIQUE INDEX IF NOT EXISTS coord_events_idempotency
  ON coordination_events(project_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS coord_events_session ON coordination_events(project_id, semantic_session, ts);
CREATE INDEX IF NOT EXISTS coord_event_links_task ON coordination_event_links(project_id, task_id);
CREATE INDEX IF NOT EXISTS coord_event_links_run ON coordination_event_links(project_id, run_id);
CREATE INDEX IF NOT EXISTS coord_event_links_session ON coordination_event_links(project_id, session_id);
CREATE INDEX IF NOT EXISTS coord_event_links_thread ON coordination_event_links(project_id, conversation_thread_id, event_id);
CREATE INDEX IF NOT EXISTS handoffs_pending ON handoffs(project_id, state, kind);
CREATE INDEX IF NOT EXISTS wake_pending ON wake_requests(project_id, state, session_ref);
CREATE UNIQUE INDEX IF NOT EXISTS wake_requests_dedupe
  ON wake_requests(project_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;
