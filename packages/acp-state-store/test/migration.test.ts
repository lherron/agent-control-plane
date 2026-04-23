import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openAcpStateStore } from '../src/index.js'

function createLegacyStateDb(): { dbPath: string; cleanup(): void } {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'acp-state-migration-'))
  const dbPath = join(fixtureDir, 'acp-state.db')
  const db = new Database(dbPath)

  db.exec(`
    CREATE TABLE runs (
      run_id TEXT PRIMARY KEY,
      scope_ref TEXT NOT NULL,
      lane_ref TEXT NOT NULL,
      task_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
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
      metadata_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX runs_session_idx
      ON runs (scope_ref, lane_ref, created_at);

    CREATE TABLE input_attempts (
      input_attempt_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      scope_ref TEXT NOT NULL,
      lane_ref TEXT NOT NULL,
      task_id TEXT,
      idempotency_key TEXT,
      fingerprint TEXT NOT NULL,
      content TEXT NOT NULL,
      actor_agent_id TEXT NOT NULL,
      metadata_json TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES runs(run_id)
    );

    CREATE UNIQUE INDEX input_attempts_idempotency_unique
      ON input_attempts (scope_ref, lane_ref, idempotency_key)
      WHERE idempotency_key IS NOT NULL;

    CREATE INDEX input_attempts_run_idx
      ON input_attempts (run_id, created_at);

    CREATE TABLE transition_outbox (
      transition_event_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      from_phase TEXT NOT NULL,
      to_phase TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'leased', 'delivered', 'failed')),
      leased_at TEXT,
      delivered_at TEXT,
      attempts INTEGER NOT NULL,
      last_error TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX transition_outbox_status_idx
      ON transition_outbox (status, created_at);
  `)

  db.prepare(
    `INSERT INTO runs (
       run_id,
       scope_ref,
       lane_ref,
       task_id,
       status,
       metadata_json,
       created_at,
       updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'run_legacy',
    'agent:cody:project:agent-spaces',
    'main',
    'T-legacy',
    'pending',
    JSON.stringify({ migrated: false }),
    '2026-04-23T09:59:00.000Z',
    '2026-04-23T09:59:00.000Z'
  )

  db.prepare(
    `INSERT INTO input_attempts (
       input_attempt_id,
       run_id,
       scope_ref,
       lane_ref,
       task_id,
       idempotency_key,
       fingerprint,
       content,
       actor_agent_id,
       metadata_json,
       created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'ia_legacy',
    'run_legacy',
    'agent:cody:project:agent-spaces',
    'main',
    'T-legacy',
    'legacy-key',
    'legacy-fingerprint',
    'legacy input',
    'clod',
    JSON.stringify({ migrated: false }),
    '2026-04-23T09:59:01.000Z'
  )

  db.prepare(
    `INSERT INTO transition_outbox (
       transition_event_id,
       task_id,
       project_id,
       from_phase,
       to_phase,
       payload_json,
       status,
       attempts,
       created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'evt_legacy',
    'T-legacy',
    'agent-spaces',
    'ready',
    'done',
    JSON.stringify({ ok: true }),
    'pending',
    0,
    '2026-04-23T09:59:02.000Z'
  )

  db.close()

  return {
    dbPath,
    cleanup() {
      rmSync(fixtureDir, { recursive: true, force: true })
    },
  }
}

function listColumnNames(store: ReturnType<typeof openAcpStateStore>, tableName: string): string[] {
  return (
    store.sqlite.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>
  ).map((row) => row.name)
}

describe('acp-state-store migrations', () => {
  test('migrates legacy actor columns and backfills legacy values on open', () => {
    const fixture = createLegacyStateDb()

    try {
      const store = openAcpStateStore({ dbPath: fixture.dbPath })

      expect(listColumnNames(store, 'runs')).toEqual(
        expect.arrayContaining(['actor_kind', 'actor_id', 'actor_display_name'])
      )
      expect(listColumnNames(store, 'input_attempts')).toEqual(
        expect.arrayContaining(['actor_kind', 'actor_id', 'actor_display_name', 'actor_agent_id'])
      )
      expect(listColumnNames(store, 'transition_outbox')).toEqual(
        expect.arrayContaining(['actor_kind', 'actor_id', 'actor_display_name'])
      )

      expect(store.runs.getRun('run_legacy')).toEqual(
        expect.objectContaining({
          runId: 'run_legacy',
          actor: { kind: 'system', id: 'acp-local' },
        })
      )

      const legacyAttemptRow = store.sqlite
        .prepare(
          `SELECT actor_kind, actor_id, actor_display_name
             FROM input_attempts
            WHERE input_attempt_id = ?`
        )
        .get('ia_legacy') as {
        actor_kind: string
        actor_id: string
        actor_display_name: string | null
      }
      expect(legacyAttemptRow).toEqual({
        actor_kind: 'agent',
        actor_id: 'clod',
        actor_display_name: null,
      })

      expect(store.transitionOutbox.get('evt_legacy')).toEqual(
        expect.objectContaining({
          transitionEventId: 'evt_legacy',
          actor: { kind: 'system', id: 'acp-local' },
        })
      )

      const createdAttempt = store.inputAttempts.createAttempt({
        sessionRef: { scopeRef: 'agent:cody:project:agent-spaces', laneRef: 'main' },
        content: 'probe',
        idempotencyKey: 'probe-migrated',
        actor: { kind: 'agent', id: 'clod' },
        runStore: store.runs,
      })

      expect(createdAttempt.created).toBe(true)
      const newAttemptRow = store.sqlite
        .prepare(
          `SELECT actor_kind, actor_id, actor_display_name
             FROM input_attempts
            WHERE input_attempt_id = ?`
        )
        .get(createdAttempt.inputAttempt.inputAttemptId) as {
        actor_kind: string
        actor_id: string
        actor_display_name: string | null
      }
      expect(newAttemptRow).toEqual({
        actor_kind: 'agent',
        actor_id: 'clod',
        actor_display_name: null,
      })

      store.close()
    } finally {
      fixture.cleanup()
    }
  })
})
