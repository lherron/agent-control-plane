import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openAcpStateStore } from 'acp-state-store'

import { InMemoryRunStore } from '../run-store.js'

const cleanupPaths: string[] = []

afterEach(() => {
  for (const path of cleanupPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

function createDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'acp-run-store-'))
  cleanupPaths.push(dir)
  return join(dir, 'acp-state.db')
}

const sessionRef = {
  scopeRef: 'agent:smokey:project:agent-spaces:task:T-01161:role:tester',
  laneRef: 'main',
} as const

describe('InMemoryRunStore', () => {
  test('clears stale error fields when a run completes successfully', () => {
    const store = new InMemoryRunStore()
    const run = store.createRun({ sessionRef, status: 'pending' })

    store.updateRun(run.runId, {
      status: 'failed',
      errorCode: 'dispatch_timeout',
      errorMessage: 'partial HRC session correlation timed out',
    })

    // T-05343: successful reconciliation after a false dispatch_timeout must
    // remove stale failure fields instead of carrying them on a completed run.
    const completed = store.updateRun(run.runId, {
      status: 'completed',
      errorCode: null as never,
      errorMessage: null as never,
    })

    expect(completed.status).toBe('completed')
    expect(completed.errorCode).toBeUndefined()
    expect(completed.errorMessage).toBeUndefined()
    expect(store.getRun(run.runId)).not.toHaveProperty('errorCode')
    expect(store.getRun(run.runId)).not.toHaveProperty('errorMessage')
  })
})

describe('SqliteRunStore', () => {
  test('persists runs, HRC correlation, and dispatch fences across reopen', () => {
    const dbPath = createDbPath()
    const firstStore = openAcpStateStore({ dbPath })

    let runId = ''
    try {
      const run = firstStore.runs.createRun({
        sessionRef,
        taskId: 'T-01161',
        metadata: {
          actorAgentId: 'smokey',
          source: 'discord',
        },
      })
      runId = run.runId

      firstStore.runs.setDispatchFence(runId, {
        expectedHostSessionId: 'host-session-001',
        expectedGeneration: 7,
        followLatest: false,
      })
      firstStore.runs.updateRun(runId, {
        status: 'failed',
        hrcRunId: 'hrc-run-001',
        hostSessionId: 'host-session-001',
        generation: 7,
        runtimeId: 'runtime-001',
        transport: 'tmux',
        errorCode: 'runtime_unavailable',
        errorMessage: 'child exited 1',
        afterHrcSeq: 42,
      })

      expect(firstStore.runs.getRun(runId)).toMatchObject({
        runId,
        scopeRef: sessionRef.scopeRef,
        laneRef: sessionRef.laneRef,
        taskId: 'T-01161',
        status: 'failed',
        hrcRunId: 'hrc-run-001',
        hostSessionId: 'host-session-001',
        generation: 7,
        runtimeId: 'runtime-001',
        transport: 'tmux',
        errorCode: 'runtime_unavailable',
        errorMessage: 'child exited 1',
        afterHrcSeq: 42,
        dispatchFence: {
          expectedHostSessionId: 'host-session-001',
          expectedGeneration: 7,
          followLatest: false,
        },
      })
    } finally {
      firstStore.close()
    }

    const reopenedStore = openAcpStateStore({ dbPath })
    try {
      expect(reopenedStore.runs.listRunsForSession(sessionRef)).toHaveLength(1)
      expect(reopenedStore.runs.getRun(runId)).toMatchObject({
        runId,
        scopeRef: sessionRef.scopeRef,
        laneRef: sessionRef.laneRef,
        taskId: 'T-01161',
        status: 'failed',
        hrcRunId: 'hrc-run-001',
        hostSessionId: 'host-session-001',
        generation: 7,
        runtimeId: 'runtime-001',
        transport: 'tmux',
        errorCode: 'runtime_unavailable',
        errorMessage: 'child exited 1',
        afterHrcSeq: 42,
        dispatchFence: {
          expectedHostSessionId: 'host-session-001',
          expectedGeneration: 7,
          followLatest: false,
        },
      })

      const row = reopenedStore.sqlite
        .prepare(
          `SELECT hrc_run_id,
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
                  after_hrc_seq
             FROM runs
            WHERE run_id = ?`
        )
        .get(runId) as {
        hrc_run_id: string
        host_session_id: string
        generation: number
        runtime_id: string
        transport: string
        error_code: string
        error_message: string
        dispatch_fence_json: string
        expected_host_session_id: string
        expected_generation: number
        follow_latest: number
        after_hrc_seq: number
      }

      expect(row).toEqual({
        hrc_run_id: 'hrc-run-001',
        host_session_id: 'host-session-001',
        generation: 7,
        runtime_id: 'runtime-001',
        transport: 'tmux',
        error_code: 'runtime_unavailable',
        error_message: 'child exited 1',
        dispatch_fence_json: JSON.stringify({
          expectedHostSessionId: 'host-session-001',
          expectedGeneration: 7,
          followLatest: false,
        }),
        expected_host_session_id: 'host-session-001',
        expected_generation: 7,
        follow_latest: 0,
        after_hrc_seq: 42,
      })
    } finally {
      reopenedStore.close()
    }
  })

  test('persists wrkf launch claim metadata across reopen', () => {
    const dbPath = createDbPath()
    const firstStore = openAcpStateStore({ dbPath })
    let runId = ''
    try {
      const { run } = firstStore.runs.createOrGetRun({
        sessionRef,
        wrkfTaskId: 'T-01161',
        wrkfInstanceId: 'inst-claim-001',
        wrkfRunId: 'wrkfrun-claim-001',
        workflowRef: 'canonical-flow@v1',
        role: 'tester',
      })
      runId = run.runId

      const claim = firstStore.runs.acquireLaunchClaim({
        runId,
        claimId: 'claim-001',
        idempotencyKey: 'idem-claim-001',
        wrkfRunId: 'wrkfrun-claim-001',
        claimedAt: '2026-06-05T22:30:00.000Z',
      })

      expect(claim.acquired).toBe(true)
      expect(claim.run.metadata?.['wrkfLaunchClaim']).toMatchObject({
        status: 'claimed',
        claimId: 'claim-001',
        idempotencyKey: 'idem-claim-001',
        wrkfRunId: 'wrkfrun-claim-001',
      })
    } finally {
      firstStore.close()
    }

    const reopenedStore = openAcpStateStore({ dbPath })
    try {
      const blocked = reopenedStore.runs.acquireLaunchClaim({
        runId,
        claimId: 'claim-002',
        idempotencyKey: 'idem-claim-001',
        wrkfRunId: 'wrkfrun-claim-001',
      })
      expect(blocked.acquired).toBe(false)
      expect(blocked.run.metadata?.['wrkfLaunchClaim']).toMatchObject({
        status: 'claimed',
        claimId: 'claim-001',
        wrkfRunId: 'wrkfrun-claim-001',
      })
    } finally {
      reopenedStore.close()
    }
  })

  test('persists cleared stale error fields when a run completes successfully', () => {
    const dbPath = createDbPath()
    const store = openAcpStateStore({ dbPath })
    let runId = ''
    try {
      const run = store.runs.createRun({ sessionRef, status: 'pending' })
      runId = run.runId
      store.runs.updateRun(runId, {
        status: 'failed',
        errorCode: 'dispatch_timeout',
        errorMessage: 'partial HRC session correlation timed out',
      })

      const completed = store.runs.updateRun(runId, {
        status: 'completed',
        errorCode: null as never,
        errorMessage: null as never,
      })

      expect(completed.status).toBe('completed')
      expect(completed.errorCode).toBeUndefined()
      expect(completed.errorMessage).toBeUndefined()

      const row = store.sqlite
        .prepare('SELECT error_code, error_message FROM runs WHERE run_id = ?')
        .get(runId) as { error_code: string | null; error_message: string | null }
      expect(row).toEqual({ error_code: null, error_message: null })
    } finally {
      store.close()
    }

    const reopenedStore = openAcpStateStore({ dbPath })
    try {
      expect(reopenedStore.runs.getRun(runId)).toMatchObject({
        runId,
        status: 'completed',
      })
      expect(reopenedStore.runs.getRun(runId)).not.toHaveProperty('errorCode')
      expect(reopenedStore.runs.getRun(runId)).not.toHaveProperty('errorMessage')
    } finally {
      reopenedStore.close()
    }
  })
})
