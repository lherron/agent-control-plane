import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openAcpStateStore } from '../src/index.js'

test('backfills legacy workflow columns and preserves writes across reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acp-state-workflow-migration-'))
  const dbPath = join(dir, 'acp-state.db')

  try {
    const legacy = new Database(dbPath)
    try {
      legacy.exec(`
        CREATE TABLE workflow_events (
          event_id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          workflow_id TEXT NOT NULL,
          workflow_version INTEGER NOT NULL,
          workflow_hash TEXT NOT NULL,
          type TEXT NOT NULL,
          actor_json TEXT NOT NULL,
          run_id TEXT,
          supervisor_run_id TEXT,
          participant_run_id TEXT,
          observed_task_version INTEGER NOT NULL,
          next_task_version INTEGER,
          context_hash TEXT,
          idempotency_key TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE workflow_obligations (
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
          satisfaction_evidence_ids_json TEXT
        );
        INSERT INTO workflow_events (
          event_id, task_id, workflow_id, workflow_version, workflow_hash, type, actor_json,
          observed_task_version, idempotency_key, payload_json, created_at
        ) VALUES ('event-1', 'task-1', 'review', 1, 'hash', 'task.created',
                  '{"kind":"system","id":"acp-local"}', 0, 'create-1', '{}', '2026-05-11');
        INSERT INTO workflow_obligations (
          obligation_id, task_id, kind, summary, blocking, status, created_at, updated_at
        ) VALUES ('obl-1', 'task-1', 'review', 'Read changes', 1, 'open', '2026-05-11', '2026-05-11');
      `)
    } finally {
      legacy.close()
    }

    const store = openAcpStateStore({ dbPath })
    try {
      const snapshot = store.workflowRuntime.loadSnapshot()
      expect(snapshot.events).toEqual([
        expect.objectContaining({
          eventId: 'event-1',
          type: 'task.created',
          workflowSeq: 0,
          schemaVersion: 1,
          result: 'accepted',
          eventHash: '',
        }),
      ])
      expect(snapshot.obligations).toEqual([
        expect.objectContaining({ obligationId: 'obl-1', summary: 'Read changes', status: 'open' }),
      ])
      store.sqlite
        .prepare('UPDATE workflow_obligations SET waived_at = ?, waiver_reason = ?')
        .run('2026-05-12', 'review complete')
    } finally {
      store.close()
    }

    const reopened = openAcpStateStore({ dbPath })
    try {
      expect(reopened.workflowRuntime.loadSnapshot().obligations).toEqual([
        expect.objectContaining({
          obligationId: 'obl-1',
          waivedAt: '2026-05-12',
          waiverReason: 'review complete',
        }),
      ])
    } finally {
      reopened.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
