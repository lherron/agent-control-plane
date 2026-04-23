import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openAcpStateStore } from 'acp-state-store'

const cleanupPaths: string[] = []

afterEach(() => {
  for (const path of cleanupPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

function createDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'acp-input-attempt-store-'))
  cleanupPaths.push(dir)
  return join(dir, 'acp-state.db')
}

const sessionRef = {
  scopeRef: 'agent:smokey:project:agent-spaces:task:T-01161:role:tester',
  laneRef: 'main',
} as const

describe('SqliteInputAttemptStore', () => {
  test('deduplicates identical idempotency keys across reopen and preserves the original run', () => {
    const dbPath = createDbPath()
    const firstStore = openAcpStateStore({ dbPath })

    let originalInputAttemptId = ''
    let originalRunId = ''
    try {
      const created = firstStore.inputAttempts.createAttempt({
        sessionRef,
        taskId: 'T-01161',
        idempotencyKey: 'discord:msg-329',
        content: 'please author the red tests',
        actor: { agentId: 'clod' },
        metadata: { source: 'discord' },
        runStore: firstStore.runs,
      })

      expect(created.created).toBe(true)
      originalInputAttemptId = created.inputAttempt.inputAttemptId
      originalRunId = created.runId
    } finally {
      firstStore.close()
    }

    const reopenedStore = openAcpStateStore({ dbPath })
    try {
      const deduplicated = reopenedStore.inputAttempts.createAttempt({
        sessionRef,
        taskId: 'T-01161',
        idempotencyKey: 'discord:msg-329',
        content: 'please author the red tests',
        actor: { agentId: 'clod' },
        metadata: { source: 'discord' },
        runStore: reopenedStore.runs,
      })

      expect(deduplicated.created).toBe(false)
      expect(deduplicated.inputAttempt.inputAttemptId).toBe(originalInputAttemptId)
      expect(deduplicated.runId).toBe(originalRunId)
      expect(reopenedStore.runs.listRunsForSession(sessionRef)).toHaveLength(1)

      const row = reopenedStore.sqlite
        .prepare(
          `SELECT run_id, idempotency_key, fingerprint, content, actor_kind, actor_id, actor_display_name
             FROM input_attempts
            WHERE input_attempt_id = ?`
        )
        .get(originalInputAttemptId) as {
        run_id: string
        idempotency_key: string
        fingerprint: string
        content: string
        actor_kind: string
        actor_id: string
        actor_display_name: string | null
      }

      expect(row.run_id).toBe(originalRunId)
      expect(row.idempotency_key).toBe('discord:msg-329')
      expect(row.fingerprint.length).toBeGreaterThan(0)
      expect(row.content).toBe('please author the red tests')
      expect(row.actor_kind).toBe('agent')
      expect(row.actor_id).toBe('clod')
      expect(row.actor_display_name).toBeNull()
    } finally {
      reopenedStore.close()
    }
  })

  test('throws a conflict when the same idempotency key is reused with a different fingerprint', () => {
    const dbPath = createDbPath()
    const firstStore = openAcpStateStore({ dbPath })

    try {
      firstStore.inputAttempts.createAttempt({
        sessionRef,
        taskId: 'T-01161',
        idempotencyKey: 'discord:msg-330',
        content: 'first body',
        actor: { agentId: 'clod' },
        metadata: { source: 'discord' },
        runStore: firstStore.runs,
      })
    } finally {
      firstStore.close()
    }

    const reopenedStore = openAcpStateStore({ dbPath })
    try {
      expect(() =>
        reopenedStore.inputAttempts.createAttempt({
          sessionRef,
          taskId: 'T-01161',
          idempotencyKey: 'discord:msg-330',
          content: 'second body',
          actor: { agentId: 'clod' },
          metadata: { source: 'discord' },
          runStore: reopenedStore.runs,
        })
      ).toThrow(/different request body already exists for idempotencyKey discord:msg-330/)
    } finally {
      reopenedStore.close()
    }
  })
})
