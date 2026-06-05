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
  test('[RED] createOrGetRun exists on InMemoryRunStore', () => {
    const store = new InMemoryRunStore()
    // FAIL: method does not exist yet
    expect(
      typeof (store as unknown as Record<string, unknown>)['createOrGetRun']
    ).toBe('function')
  })

  test('[RED] first call returns { run, created: true }', () => {
    const store = new InMemoryRunStore()
    const callFn = (store as unknown as Record<string, (...args: unknown[]) => unknown>)[
      'createOrGetRun'
    ].bind(store)

    const result = callFn(BASE) as { run: { runId: string }; created: boolean }
    expect(result.created).toBe(true)
    expect(result.run.runId).toBe(`run_wrkf_${BASE.wrkfRunId}`)
  })

  test('[RED] stored run has deterministic runId run_wrkf_<wrkfRunId>', () => {
    const store = new InMemoryRunStore()
    const callFn = (store as unknown as Record<string, (...args: unknown[]) => unknown>)[
      'createOrGetRun'
    ].bind(store)

    const { run } = callFn(BASE) as { run: { runId: string }; created: boolean }
    expect(run.runId).toBe(`run_wrkf_${BASE.wrkfRunId}`)
  })

  test('[RED] getRun can retrieve the run by the deterministic id', () => {
    const store = new InMemoryRunStore()
    const callFn = (store as unknown as Record<string, (...args: unknown[]) => unknown>)[
      'createOrGetRun'
    ].bind(store)

    callFn(BASE)
    const found = store.getRun(`run_wrkf_${BASE.wrkfRunId}`)
    expect(found).toBeDefined()
  })

  test('[RED] stored metadata carries source:wrkf and all wrkf fields', () => {
    const store = new InMemoryRunStore()
    const callFn = (store as unknown as Record<string, (...args: unknown[]) => unknown>)[
      'createOrGetRun'
    ].bind(store)

    const { run } = callFn(BASE) as {
      run: { metadata: Record<string, unknown> }
      created: boolean
    }
    expect(run.metadata?.['source']).toBe('wrkf')
    expect(run.metadata?.['wrkfTaskId']).toBe(BASE.wrkfTaskId)
    expect(run.metadata?.['wrkfInstanceId']).toBe(BASE.wrkfInstanceId)
    expect(run.metadata?.['wrkfRunId']).toBe(BASE.wrkfRunId)
    expect(run.metadata?.['workflowRef']).toBe(BASE.workflowRef)
    expect(run.metadata?.['role']).toBe(BASE.role)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Section 2: InMemoryRunStore.createOrGetRun — replay [RED]
// ─────────────────────────────────────────────────────────────────────────────

describe('InMemoryRunStore.createOrGetRun — replay (W4a red)', () => {
  test('[RED] second call returns created: false', () => {
    const store = new InMemoryRunStore()
    const callFn = (store as unknown as Record<string, (...args: unknown[]) => unknown>)[
      'createOrGetRun'
    ].bind(store)

    callFn(BASE)
    const r2 = callFn(BASE) as { run: unknown; created: boolean }
    expect(r2.created).toBe(false)
  })

  test('[RED] two calls return the same runId', () => {
    const store = new InMemoryRunStore()
    const callFn = (store as unknown as Record<string, (...args: unknown[]) => unknown>)[
      'createOrGetRun'
    ].bind(store)

    const r1 = callFn(BASE) as { run: { runId: string }; created: boolean }
    const r2 = callFn(BASE) as { run: { runId: string }; created: boolean }
    expect(r1.run.runId).toBe(r2.run.runId)
  })

  test('[RED] listRuns contains exactly one entry after two identical calls', () => {
    const store = new InMemoryRunStore()
    const callFn = (store as unknown as Record<string, (...args: unknown[]) => unknown>)[
      'createOrGetRun'
    ].bind(store)

    callFn(BASE)
    callFn(BASE)

    const all = store.listRuns()
    const matches = all.filter((r) => r.runId === `run_wrkf_${BASE.wrkfRunId}`)
    expect(matches).toHaveLength(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Section 3: InMemoryRunStore.createOrGetRun — conflict [RED]
// ─────────────────────────────────────────────────────────────────────────────

describe('InMemoryRunStore.createOrGetRun — conflict (W4a red)', () => {
  test('[RED] different wrkfTaskId for same wrkfRunId throws RunCorrelationConflictError', async () => {
    // Import RunCorrelationConflictError from acp-state-store once it exists
    const ssModule = await import('acp-state-store')
    const { RunCorrelationConflictError } = ssModule as unknown as {
      RunCorrelationConflictError: new (...args: unknown[]) => Error
    }

    const store = new InMemoryRunStore()
    const callFn = (store as unknown as Record<string, (...args: unknown[]) => unknown>)[
      'createOrGetRun'
    ].bind(store)

    callFn(BASE)
    expect(() => callFn({ ...BASE, wrkfTaskId: 'T-CONFLICT' })).toThrow(RunCorrelationConflictError)
  })

  test('[RED] different workflowRef for same wrkfRunId throws RunCorrelationConflictError', async () => {
    const ssModule = await import('acp-state-store')
    const { RunCorrelationConflictError } = ssModule as unknown as {
      RunCorrelationConflictError: new (...args: unknown[]) => Error
    }

    const store = new InMemoryRunStore()
    const callFn = (store as unknown as Record<string, (...args: unknown[]) => unknown>)[
      'createOrGetRun'
    ].bind(store)

    callFn(BASE)
    expect(() => callFn({ ...BASE, workflowRef: 'other-flow@v99' })).toThrow(
      RunCorrelationConflictError
    )
  })

  test('[RED] different role for same wrkfRunId throws RunCorrelationConflictError', async () => {
    const ssModule = await import('acp-state-store')
    const { RunCorrelationConflictError } = ssModule as unknown as {
      RunCorrelationConflictError: new (...args: unknown[]) => Error
    }

    const store = new InMemoryRunStore()
    const callFn = (store as unknown as Record<string, (...args: unknown[]) => unknown>)[
      'createOrGetRun'
    ].bind(store)

    callFn(BASE)
    expect(() => callFn({ ...BASE, role: 'supervisor' })).toThrow(RunCorrelationConflictError)
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
