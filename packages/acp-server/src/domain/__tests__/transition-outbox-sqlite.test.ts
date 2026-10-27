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
      const persisted = reopenedStore.transitionOutbox.get('tevt-001')
      expect(persisted).toMatchObject({
        transitionEventId: 'tevt-001',
        status: 'delivered',
        attempts: 1,
        lastError: null,
        payload: {
          transitionEventId: 'tevt-001',
          taskId: 'T-01161',
          toPhase: 'verified',
        },
      })
      expect(persisted?.leasedAt).toEqual(expect.any(String))
      expect(persisted?.deliveredAt).toEqual(expect.any(String))
      // A delivered row is never leased again after reopen
      expect(reopenedStore.transitionOutbox.leaseNext()).toBeUndefined()
    } finally {
      reopenedStore.close()
    }
  })

  test('appending the same transitionEventId twice returns the original pending row', () => {
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

      expect(store.transitionOutbox.get('tevt-002')).toEqual(first)
      expect(first).toMatchObject({ status: 'pending', attempts: 0 })
      expect(store.transitionOutbox.leaseNext()?.transitionEventId).toBe('tevt-002')
      store.transitionOutbox.markDelivered('tevt-002')
      expect(store.transitionOutbox.leaseNext()).toBeUndefined()
    } finally {
      store.close()
    }
  })

  test('retries delivery errors until the max attempt then marks failed terminal', () => {
    const dbPath = createDbPath()
    const store = openAcpStateStore({ dbPath })

    try {
      store.transitionOutbox.append({
        transitionEventId: 'tevt-003',
        taskId: 'T-01161',
        projectId: 'P-00002',
        fromPhase: 'implemented',
        toPhase: 'verified',
        payload: { transitionEventId: 'tevt-003' },
      })

      expect(store.transitionOutbox.leaseNext()).toMatchObject({
        transitionEventId: 'tevt-003',
        attempts: 1,
      })
      expect(store.transitionOutbox.markErrored('tevt-003', 'first failure')).toMatchObject({
        transitionEventId: 'tevt-003',
        status: 'leased',
        attempts: 1,
        lastError: 'first failure',
      })

      expect(store.transitionOutbox.leaseNext()).toMatchObject({
        transitionEventId: 'tevt-003',
        attempts: 2,
        lastError: null,
      })
      expect(store.transitionOutbox.markErrored('tevt-003', 'second failure')).toMatchObject({
        transitionEventId: 'tevt-003',
        status: 'leased',
        attempts: 2,
        lastError: 'second failure',
      })

      expect(store.transitionOutbox.leaseNext()).toMatchObject({
        transitionEventId: 'tevt-003',
        attempts: 3,
        lastError: null,
      })
      expect(store.transitionOutbox.markErrored('tevt-003', 'third failure')).toMatchObject({
        transitionEventId: 'tevt-003',
        status: 'failed',
        attempts: 3,
        lastError: 'third failure',
      })

      expect(store.transitionOutbox.leaseNext()).toBeUndefined()
    } finally {
      store.close()
    }
  })
})
