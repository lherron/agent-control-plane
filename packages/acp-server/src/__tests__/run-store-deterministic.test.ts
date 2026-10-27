/**
 * RED TESTS — W4a: deterministic run identity in RunStore / InMemoryRunStore (T-01933)
 *
 * Companion to acp-state-store/test/run-repo-deterministic.test.ts which covers
 * the SQLite-backed RunRepo. This file covers the RunStore interface and the
 * in-process InMemoryRunStore used by unit tests throughout acp-server.
 *
 * All tests FAIL NOW — createOrGetRun does not exist on InMemoryRunStore or the
 * RunStore interface yet.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IMPL CONTRACT — what must be added to go green:
 *
 * In packages/acp-server/src/domain/run-store.ts:
 *
 *   1. Extend RunStore interface:
 *        createOrGetRun(input: {
 *          sessionRef: SessionRef
 *          wrkfTaskId: string
 *          wrkfInstanceId: string
 *          wrkfRunId: string
 *          workflowRef: string
 *          role: string
 *          actor?: Actor | undefined
 *          status?: Run['status'] | undefined
 *        }): { run: StoredRun; created: boolean }
 *
 *   2. Implement createOrGetRun on InMemoryRunStore with same replay/conflict
 *      semantics as RunRepo:
 *        - key = `run_wrkf_${wrkfRunId}` (mirrors deriveRunId)
 *        - INSERT OR IGNORE (Map.has check): replay if already present
 *        - Conflict fields: wrkfTaskId, wrkfRunId, workflowRef, role
 *        - On conflict: throw RunCorrelationConflictError (import from acp-state-store)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { describe, expect, test } from 'bun:test'

import { InMemoryRunStore } from '../domain/run-store.js'

// ─── Shared fixtures ─────────────────────────────────────────────────────────

const SESSION = { scopeRef: 'agent:smokey:project:acp-server-test', laneRef: 'main' }

const BASE = {
  sessionRef: SESSION,
  wrkfTaskId: 'T-09991',
  wrkfInstanceId: 'inst_bbb222',
  wrkfRunId: 'wrkf-run-inmem-001',
  workflowRef: 'canonical-flow@v1',
  role: 'implementer',
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 1: InMemoryRunStore.createOrGetRun — first call [RED]
// ─────────────────────────────────────────────────────────────────────────────

describe('InMemoryRunStore.createOrGetRun — initial creation (W4a red)', () => {
  test('first creation returns and stores deterministic wrkf identity and metadata', () => {
    const store = new InMemoryRunStore()
    const { run, created } = store.createOrGetRun(BASE)
    expect(created).toBe(true)
    expect(run.runId).toBe(`run_wrkf_${BASE.wrkfRunId}`)
    expect(store.getRun(run.runId)).toBeDefined()
    expect(run.metadata).toMatchObject({
      source: 'wrkf',
      wrkfTaskId: BASE.wrkfTaskId,
      wrkfInstanceId: BASE.wrkfInstanceId,
      wrkfRunId: BASE.wrkfRunId,
      workflowRef: BASE.workflowRef,
      role: BASE.role,
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Section 2: InMemoryRunStore.createOrGetRun — replay [RED]
// ─────────────────────────────────────────────────────────────────────────────

describe('InMemoryRunStore.createOrGetRun — replay (W4a red)', () => {
  test('replay returns the same deterministic run without another entry', () => {
    const store = new InMemoryRunStore()
    const first = store.createOrGetRun(BASE)
    const second = store.createOrGetRun(BASE)
    expect(second.created).toBe(false)
    expect(first.run.runId).toBe(second.run.runId)
    expect(
      store.listRuns().filter((run) => run.runId === `run_wrkf_${BASE.wrkfRunId}`)
    ).toHaveLength(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Section 3: InMemoryRunStore.createOrGetRun — conflict [RED]
// ─────────────────────────────────────────────────────────────────────────────

describe('InMemoryRunStore.createOrGetRun — conflict (W4a red)', () => {
  test.each([
    { wrkfTaskId: 'T-CONFLICT' },
    { workflowRef: 'other-flow@v99' },
    { role: 'supervisor' },
  ])('conflicting wrkf correlation field is rejected: %o', async (change) => {
    const { RunCorrelationConflictError } = await import('acp-state-store')
    const store = new InMemoryRunStore()
    store.createOrGetRun(BASE)
    expect(() => store.createOrGetRun({ ...BASE, ...change })).toThrow(RunCorrelationConflictError)
  })

  test('[RED] different wrkfInstanceId does NOT conflict (instance may rotate)', async () => {
    const store = new InMemoryRunStore()
    const callFn = (store as unknown as Record<string, (...args: unknown[]) => unknown>)[
      'createOrGetRun'
    ].bind(store)

    callFn(BASE)
    // rotating wrkfInstanceId is fine — not a conflict field
    expect(() => callFn({ ...BASE, wrkfInstanceId: 'inst_rotated_ccc333' })).not.toThrow()
  })
})
