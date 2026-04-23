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
  const dir = mkdtempSync(join(tmpdir(), 'acp-run-store-'))
  cleanupPaths.push(dir)
  return join(dir, 'acp-state.db')
}

const sessionRef = {
  scopeRef: 'agent:smokey:project:agent-spaces:task:T-01161:role:tester',
  laneRef: 'main',
} as const

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
                  follow_latest
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
      })
    } finally {
      reopenedStore.close()
    }
  })
})
