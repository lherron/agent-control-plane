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
  const dir = mkdtempSync(join(tmpdir(), 'acp-transition-outbox-'))
  cleanupPaths.push(dir)
  return join(dir, 'acp-state.db')
}

describe('TransitionOutboxRepo', () => {
  test('leases pending rows, marks them delivered, and persists delivery state across reopen', () => {
    const dbPath = createDbPath()
    const firstStore = openAcpStateStore({ dbPath })

    try {
      const appended = firstStore.transitionOutbox.append({
        transitionEventId: 'tevt-001',
        taskId: 'T-01161',
        projectId: 'P-00002',
        fromPhase: 'implemented',
        toPhase: 'verified',
        payload: {
          transitionEventId: 'tevt-001',
          taskId: 'T-01161',
          toPhase: 'verified',
        },
      })

      expect(appended).toMatchObject({
        transitionEventId: 'tevt-001',
        status: 'pending',
        attempts: 0,
      })

      const leased = firstStore.transitionOutbox.leaseNext()
      expect(leased).toMatchObject({
        transitionEventId: 'tevt-001',
        status: 'leased',
        attempts: 1,
      })

      firstStore.transitionOutbox.markDelivered('tevt-001')
    } finally {
      firstStore.close()
    }

    const reopenedStore = openAcpStateStore({ dbPath })
    try {
      const row = reopenedStore.sqlite
        .prepare(
          `SELECT status, leased_at, delivered_at, attempts, last_error, payload_json
             FROM transition_outbox
            WHERE transition_event_id = ?`
        )
        .get('tevt-001') as {
        status: string
        leased_at: string | null
        delivered_at: string | null
        attempts: number
        last_error: string | null
        payload_json: string
      }

      expect(row.status).toBe('delivered')
      expect(row.leased_at).not.toBeNull()
      expect(row.delivered_at).not.toBeNull()
      expect(row.attempts).toBe(1)
      expect(row.last_error).toBeNull()
      expect(JSON.parse(row.payload_json)).toEqual({
        transitionEventId: 'tevt-001',
        taskId: 'T-01161',
        toPhase: 'verified',
      })
    } finally {
      reopenedStore.close()
    }
  })

  test('treats append as idempotent by transitionEventId', () => {
    const dbPath = createDbPath()
    const store = openAcpStateStore({ dbPath })

    try {
      const first = store.transitionOutbox.append({
        transitionEventId: 'tevt-002',
        taskId: 'T-01161',
        projectId: 'P-00002',
        fromPhase: 'implemented',
        toPhase: 'verified',
        payload: { transitionEventId: 'tevt-002' },
      })
      const second = store.transitionOutbox.append({
        transitionEventId: 'tevt-002',
        taskId: 'T-01161',
        projectId: 'P-00002',
        fromPhase: 'implemented',
        toPhase: 'verified',
        payload: { transitionEventId: 'tevt-002' },
      })

      expect(second).toEqual(first)

      const row = store.sqlite
        .prepare(
          `SELECT COUNT(*) AS total, status, attempts
             FROM transition_outbox
            WHERE transition_event_id = ?`
        )
        .get('tevt-002') as {
        total: number
        status: string
        attempts: number
      }

      expect(row.total).toBe(1)
      expect(row.status).toBe('pending')
      expect(row.attempts).toBe(0)
    } finally {
      store.close()
    }
  })
})
