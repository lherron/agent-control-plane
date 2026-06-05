/**
 * RED TESTS — W4a: deterministic ACP run correlation in RunRepo/RunStore (T-01933)
 *
 * Problem today:
 *   RunRepo.createRun generates `run_${randomUUID()}` — non-deterministic.
 *   W4b's HRC launch/bind split requires stable run identity so a crashed
 *   dispatch can retry without creating duplicate DB rows (replay-safe).
 *
 * This file asserts the full contract that createOrGetRun must satisfy.
 * All tests in describe blocks marked [RED] FAIL NOW — createOrGetRun and
 * deriveRunId do not exist yet.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IMPL CONTRACT — what must be added to go green:
 *
 * 1. packages/acp-state-store/src/repos/run-repo.ts
 *
 *    Export a pure derivation function:
 *      export function deriveRunId(wrkfRunId: string): string {
 *        return `run_wrkf_${wrkfRunId}`
 *      }
 *
 *    Add method to RunRepo:
 *      createOrGetRun(input: {
 *        sessionRef: SessionRef
 *        wrkfTaskId: string
 *        wrkfInstanceId: string
 *        wrkfRunId: string
 *        workflowRef: string
 *        role: string
 *        actor?: Actor | undefined
 *        status?: StoredRun['status'] | undefined
 *      }): { run: StoredRun; created: boolean }
 *
 *    Semantics (INSERT OR IGNORE on PK = deriveRunId(wrkfRunId)):
 *      - No existing row → insert, return { run, created: true }
 *      - Existing row, metadata matches → return { run, created: false }
 *      - Existing row, metadata conflicts → throw RunCorrelationConflictError
 *    Conflict fields: wrkfTaskId, wrkfRunId, workflowRef, role
 *    (wrkfInstanceId changes are NOT a conflict — instance may rotate for same run)
 *
 *    Export an error class:
 *      export class RunCorrelationConflictError extends Error {
 *        readonly runId: string
 *        readonly field: string
 *        readonly expected: unknown
 *        readonly actual: unknown
 *      }
 *
 *    Stored metadata shape:
 *      { source: 'wrkf', wrkfTaskId, wrkfInstanceId, wrkfRunId, workflowRef, role }
 *
 * 2. packages/acp-state-store/src/index.ts
 *    Export: RunCorrelationConflictError, deriveRunId
 *
 * 3. packages/acp-server/src/domain/run-store.ts
 *    Add createOrGetRun to the RunStore interface (same input/output as RunRepo).
 *    Add createOrGetRun to InMemoryRunStore with identical replay/conflict semantics.
 * ─────────────────────────────────────────────────────────────────────────
 */

import { describe, expect, test } from 'bun:test'

import { openAcpStateStore } from '../src/index.js'
// deriveRunId and RunCorrelationConflictError are imported via `as any` because
// they do not exist yet — the cast is intentional to let the file parse/compile
// while the runtime fails with "not a function" / "not a constructor".
import * as runRepoModule from '../src/repos/run-repo.js'

// ─── Shared fixtures ─────────────────────────────────────────────────────────

const SESSION = { scopeRef: 'agent:smokey:project:test', laneRef: 'main' }

const BASE = {
  sessionRef: SESSION,
  wrkfTaskId: 'T-09990',
  wrkfInstanceId: 'inst_aaa111',
  wrkfRunId: 'wrkf-run-det-001',
  workflowRef: 'canonical-flow@v1',
  role: 'implementer',
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 1: deriveRunId — pure, stable, side-effect-free [RED]
// ─────────────────────────────────────────────────────────────────────────────

describe('deriveRunId — stable pure function (W4a red)', () => {
  test('[RED] calling deriveRunId twice with the same wrkfRunId returns the same string', () => {
    // FAIL: deriveRunId is not exported from run-repo.ts yet
    const { deriveRunId } = runRepoModule as unknown as { deriveRunId: (id: string) => string }
    const wrkfRunId = 'wrkf-run-det-001'
    expect(deriveRunId(wrkfRunId)).toBe(deriveRunId(wrkfRunId))
  })

  test('[RED] deriveRunId starts with the run_wrkf_ prefix', () => {
    const { deriveRunId } = runRepoModule as unknown as { deriveRunId: (id: string) => string }
    const result = deriveRunId('wrkf-run-prefix-check')
    expect(result).toMatch(/^run_wrkf_/)
  })

  test('[RED] deriveRunId embeds the wrkfRunId verbatim after the prefix', () => {
    // Guarantees traceability: the wrkfRunId is recoverable from the ACP runId
    const { deriveRunId } = runRepoModule as unknown as { deriveRunId: (id: string) => string }
    const wrkfRunId = 'wrkf-run-traceability'
    expect(deriveRunId(wrkfRunId)).toBe(`run_wrkf_${wrkfRunId}`)
  })

  test('[RED] deriveRunId produces distinct ids for distinct wrkfRunIds', () => {
    const { deriveRunId } = runRepoModule as unknown as { deriveRunId: (id: string) => string }
    expect(deriveRunId('wrkf-run-aaa')).not.toBe(deriveRunId('wrkf-run-bbb'))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Section 2: createOrGetRun — first call creates a new run [RED]
// ─────────────────────────────────────────────────────────────────────────────

describe('RunRepo.createOrGetRun — initial creation (W4a red)', () => {
  test('[RED] createOrGetRun returns a result with { run, created }', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const result = (store.runs as unknown as Record<string, (...args: unknown[]) => unknown>)[
        'createOrGetRun'
      ](BASE) as { run: { runId: string; metadata: Record<string, unknown> }; created: boolean }

      expect(result).toBeDefined()
      expect(typeof result.created).toBe('boolean')
      expect(result.run).toBeDefined()
    } finally {
      store.close()
    }
  })

  test('[RED] first call sets created: true', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const result = (store.runs as unknown as Record<string, (...args: unknown[]) => unknown>)[
        'createOrGetRun'
      ](BASE) as { run: unknown; created: boolean }

      expect(result.created).toBe(true)
    } finally {
      store.close()
    }
  })

  test('[RED] the returned runId equals deriveRunId(wrkfRunId)', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    const { deriveRunId } = runRepoModule as unknown as { deriveRunId: (id: string) => string }
    try {
      const result = (store.runs as unknown as Record<string, (...args: unknown[]) => unknown>)[
        'createOrGetRun'
      ](BASE) as { run: { runId: string }; created: boolean }

      expect(result.run.runId).toBe(deriveRunId(BASE.wrkfRunId))
    } finally {
      store.close()
    }
  })

  test('[RED] the run can be retrieved by the deterministic runId', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    const { deriveRunId } = runRepoModule as unknown as { deriveRunId: (id: string) => string }
    try {
      ;(store.runs as unknown as Record<string, (...args: unknown[]) => unknown>)['createOrGetRun'](
        BASE
      )

      const found = store.runs.getRun(deriveRunId(BASE.wrkfRunId))
      expect(found).toBeDefined()
      expect(found?.runId).toBe(deriveRunId(BASE.wrkfRunId))
    } finally {
      store.close()
    }
  })

  test('[RED] stored metadata carries source:wrkf and all wrkf fields', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const result = (store.runs as unknown as Record<string, (...args: unknown[]) => unknown>)[
        'createOrGetRun'
      ](BASE) as { run: { metadata: Record<string, unknown> }; created: boolean }

      expect(result.run.metadata).toBeDefined()
      expect(result.run.metadata['source']).toBe('wrkf')
      expect(result.run.metadata['wrkfTaskId']).toBe(BASE.wrkfTaskId)
      expect(result.run.metadata['wrkfInstanceId']).toBe(BASE.wrkfInstanceId)
      expect(result.run.metadata['wrkfRunId']).toBe(BASE.wrkfRunId)
      expect(result.run.metadata['workflowRef']).toBe(BASE.workflowRef)
      expect(result.run.metadata['role']).toBe(BASE.role)
    } finally {
      store.close()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Section 3: createOrGetRun — replay semantics [RED]
// ─────────────────────────────────────────────────────────────────────────────

describe('RunRepo.createOrGetRun — replay (W4a red)', () => {
  test('[RED] calling twice with the same wrkfRunId returns the same runId', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const callFn = (store.runs as unknown as Record<string, (...args: unknown[]) => unknown>)[
        'createOrGetRun'
      ].bind(store.runs)

      const r1 = callFn(BASE) as { run: { runId: string }; created: boolean }
      const r2 = callFn(BASE) as { run: { runId: string }; created: boolean }

      expect(r1.run.runId).toBe(r2.run.runId)
    } finally {
      store.close()
    }
  })

  test('[RED] second call sets created: false (replay, not new insert)', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const callFn = (store.runs as unknown as Record<string, (...args: unknown[]) => unknown>)[
        'createOrGetRun'
      ].bind(store.runs)

      callFn(BASE)
      const r2 = callFn(BASE) as { run: unknown; created: boolean }

      expect(r2.created).toBe(false)
    } finally {
      store.close()
    }
  })

  test('[RED] replay returns the original createdAt (no new row)', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const callFn = (store.runs as unknown as Record<string, (...args: unknown[]) => unknown>)[
        'createOrGetRun'
      ].bind(store.runs)

      const r1 = callFn(BASE) as { run: { createdAt: string; runId: string }; created: boolean }
      const r2 = callFn(BASE) as { run: { createdAt: string; runId: string }; created: boolean }

      // Same row — createdAt must not change
      expect(r2.run.createdAt).toBe(r1.run.createdAt)
    } finally {
      store.close()
    }
  })

  test('[RED] only one row exists in DB after two identical createOrGetRun calls', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const callFn = (store.runs as unknown as Record<string, (...args: unknown[]) => unknown>)[
        'createOrGetRun'
      ].bind(store.runs)

      callFn(BASE)
      callFn(BASE)

      const all = store.runs.listRunsForSession(SESSION)
      // Exactly one ACP run for this session/wrkfRunId combo
      const matches = all.filter((r) => r.runId.includes(BASE.wrkfRunId))
      expect(matches).toHaveLength(1)
    } finally {
      store.close()
    }
  })

  test('[RED] replay with different wrkfInstanceId does NOT conflict (instance may rotate)', () => {
    // wrkfInstanceId is metadata-only — it is NOT a conflict field
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const callFn = (store.runs as unknown as Record<string, (...args: unknown[]) => unknown>)[
        'createOrGetRun'
      ].bind(store.runs)

      callFn(BASE)

      // Different wrkfInstanceId — should replay without throwing
      expect(() => callFn({ ...BASE, wrkfInstanceId: 'inst_rotated_bbb222' })).not.toThrow()
    } finally {
      store.close()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Section 4: createOrGetRun — conflict detection [RED]
// ─────────────────────────────────────────────────────────────────────────────

describe('RunRepo.createOrGetRun — conflict (W4a red)', () => {
  test('[RED] throws RunCorrelationConflictError when wrkfTaskId changes for the same runId', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    const { RunCorrelationConflictError } = runRepoModule as unknown as {
      RunCorrelationConflictError: new (...args: unknown[]) => Error
    }
    try {
      const callFn = (store.runs as unknown as Record<string, (...args: unknown[]) => unknown>)[
        'createOrGetRun'
      ].bind(store.runs)

      callFn(BASE) // creates run_wrkf_wrkf-run-det-001

      // Same wrkfRunId → same PK, but different wrkfTaskId → conflict
      expect(() => callFn({ ...BASE, wrkfTaskId: 'T-DIFFERENT' })).toThrow(
        RunCorrelationConflictError
      )
    } finally {
      store.close()
    }
  })

  test('[RED] throws RunCorrelationConflictError when workflowRef changes for the same runId', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    const { RunCorrelationConflictError } = runRepoModule as unknown as {
      RunCorrelationConflictError: new (...args: unknown[]) => Error
    }
    try {
      const callFn = (store.runs as unknown as Record<string, (...args: unknown[]) => unknown>)[
        'createOrGetRun'
      ].bind(store.runs)

      callFn(BASE)

      expect(() => callFn({ ...BASE, workflowRef: 'other-workflow@v2' })).toThrow(
        RunCorrelationConflictError
      )
    } finally {
      store.close()
    }
  })

  test('[RED] throws RunCorrelationConflictError when role changes for the same runId', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    const { RunCorrelationConflictError } = runRepoModule as unknown as {
      RunCorrelationConflictError: new (...args: unknown[]) => Error
    }
    try {
      const callFn = (store.runs as unknown as Record<string, (...args: unknown[]) => unknown>)[
        'createOrGetRun'
      ].bind(store.runs)

      callFn(BASE)

      expect(() => callFn({ ...BASE, role: 'reviewer' })).toThrow(RunCorrelationConflictError)
    } finally {
      store.close()
    }
  })

  test('[RED] conflict error carries runId, field, expected, and actual', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    const { RunCorrelationConflictError } = runRepoModule as unknown as {
      RunCorrelationConflictError: new (
        ...args: unknown[]
      ) => Error & {
        runId: string
        field: string
        expected: unknown
        actual: unknown
      }
    }
    const { deriveRunId } = runRepoModule as unknown as { deriveRunId: (id: string) => string }
    try {
      const callFn = (store.runs as unknown as Record<string, (...args: unknown[]) => unknown>)[
        'createOrGetRun'
      ].bind(store.runs)

      callFn(BASE)

      try {
        callFn({ ...BASE, wrkfTaskId: 'T-DIFFERENT' })
        throw new Error('expected conflict to be thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(RunCorrelationConflictError)
        const conflict = err as Error & {
          runId: string
          field: string
          expected: unknown
          actual: unknown
        }
        expect(conflict.runId).toBe(deriveRunId(BASE.wrkfRunId))
        expect(conflict.field).toBe('wrkfTaskId')
        expect(conflict.expected).toBe(BASE.wrkfTaskId)
        expect(conflict.actual).toBe('T-DIFFERENT')
      }
    } finally {
      store.close()
    }
  })

  test('[RED] conflict does NOT mutate the existing run (DB row unchanged)', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    const { deriveRunId } = runRepoModule as unknown as { deriveRunId: (id: string) => string }
    try {
      const callFn = (store.runs as unknown as Record<string, (...args: unknown[]) => unknown>)[
        'createOrGetRun'
      ].bind(store.runs)

      const r1 = callFn(BASE) as { run: { runId: string; metadata: Record<string, unknown> } }

      try {
        callFn({ ...BASE, wrkfTaskId: 'T-SHOULD-NOT-OVERWRITE' })
      } catch {
        // expected — swallow
      }

      const after = store.runs.getRun(deriveRunId(BASE.wrkfRunId))
      expect(after?.metadata?.['wrkfTaskId']).toBe(BASE.wrkfTaskId)
      expect(after?.metadata?.['wrkfTaskId']).toBe(r1.run.metadata['wrkfTaskId'])
    } finally {
      store.close()
    }
  })
})

describe('RunRepo.acquireLaunchClaim — durable launch exclusion (T-01934)', () => {
  test('acquires one wrkf launch claim and replays blocked on the second claim', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const { run } = store.runs.createOrGetRun(BASE)

      const first = store.runs.acquireLaunchClaim({
        runId: run.runId,
        claimId: 'claim-one',
        idempotencyKey: 'idem-one',
        wrkfRunId: BASE.wrkfRunId,
        claimedAt: '2026-06-05T22:45:00.000Z',
      })
      expect(first.acquired).toBe(true)
      expect(first.run.metadata?.['wrkfLaunchClaim']).toMatchObject({
        status: 'claimed',
        claimId: 'claim-one',
        idempotencyKey: 'idem-one',
        wrkfRunId: BASE.wrkfRunId,
      })

      const second = store.runs.acquireLaunchClaim({
        runId: run.runId,
        claimId: 'claim-two',
        idempotencyKey: 'idem-one',
        wrkfRunId: BASE.wrkfRunId,
      })
      expect(second.acquired).toBe(false)
      expect(second.run.metadata?.['wrkfLaunchClaim']).toMatchObject({
        status: 'claimed',
        claimId: 'claim-one',
        wrkfRunId: BASE.wrkfRunId,
      })
    } finally {
      store.close()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Section 5: exports — RunCorrelationConflictError is exported from the package [RED]
// ─────────────────────────────────────────────────────────────────────────────

describe('RunCorrelationConflictError — package export (W4a red)', () => {
  test('[RED] RunCorrelationConflictError is exported from acp-state-store index', async () => {
    // Fail: the export does not exist yet
    const indexModule = await import('../src/index.js')
    const { RunCorrelationConflictError } = indexModule as unknown as {
      RunCorrelationConflictError: unknown
    }
    expect(RunCorrelationConflictError).toBeDefined()
    expect(typeof RunCorrelationConflictError).toBe('function') // it is a class constructor
  })

  test('[RED] deriveRunId is exported from acp-state-store index', async () => {
    const indexModule = await import('../src/index.js')
    const { deriveRunId } = indexModule as unknown as { deriveRunId: unknown }
    expect(deriveRunId).toBeDefined()
    expect(typeof deriveRunId).toBe('function')
  })
})
