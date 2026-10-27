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
import * as runRepoModule from '../src/index.js'

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
  test('derives stable distinct run IDs that preserve each workflow run ID', () => {
    const { deriveRunId } = runRepoModule
    expect(deriveRunId('wrkf-run-traceability')).toBe('run_wrkf_wrkf-run-traceability')
    expect(deriveRunId('wrkf-run-prefix-check')).toMatch(/^run_wrkf_/)
    expect(deriveRunId('wrkf-run-aaa')).not.toBe(deriveRunId('wrkf-run-bbb'))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Section 2: createOrGetRun — first call creates a new run [RED]
// ─────────────────────────────────────────────────────────────────────────────

describe('RunRepo.createOrGetRun — initial creation (W4a red)', () => {
  test('first workflow run admission creates a deterministic, retrievable run with correlation metadata', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const result = store.runs.createOrGetRun(BASE)
      expect(result.created).toBe(true)
      expect(result.run.runId).toBe(runRepoModule.deriveRunId(BASE.wrkfRunId))
      expect(store.runs.getRun(result.run.runId)?.runId).toBe(result.run.runId)
      expect(result.run.metadata).toMatchObject({
        source: 'wrkf',
        wrkfTaskId: BASE.wrkfTaskId,
        wrkfInstanceId: BASE.wrkfInstanceId,
        wrkfRunId: BASE.wrkfRunId,
        workflowRef: BASE.workflowRef,
        role: BASE.role,
      })
    } finally {
      store.close()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Section 3: createOrGetRun — replay semantics [RED]
// ─────────────────────────────────────────────────────────────────────────────

describe('RunRepo.createOrGetRun — replay (W4a red)', () => {
  test('replaying workflow run admission returns the same run and keeps one row', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const first = store.runs.createOrGetRun(BASE)
      const replay = store.runs.createOrGetRun(BASE)
      expect(replay.created).toBe(false)
      expect(replay.run.runId).toBe(first.run.runId)
      expect(replay.run.createdAt).toBe(first.run.createdAt)
      const matches = store.runs
        .listRunsForSession(SESSION)
        .filter((run) => run.runId.includes(BASE.wrkfRunId))
      expect(matches).toHaveLength(1)
    } finally {
      store.close()
    }
  })

  test('a rotated workflow instance replays the original run instead of creating another', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const first = store.runs.createOrGetRun(BASE)
      const replay = store.runs.createOrGetRun({ ...BASE, wrkfInstanceId: 'inst_rotated_bbb222' })
      expect(replay.created).toBe(false)
      expect(replay.run.runId).toBe(first.run.runId)
      expect(replay.run.metadata.wrkfInstanceId).toBe(BASE.wrkfInstanceId)
    } finally {
      store.close()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Section 4: createOrGetRun — conflict detection [RED]
// ─────────────────────────────────────────────────────────────────────────────

describe('RunRepo.createOrGetRun — conflict (W4a red)', () => {
  test.each([
    ['wrkfTaskId', 'T-DIFFERENT'],
    ['workflowRef', 'other-workflow@v2'],
    ['role', 'reviewer'],
  ] as const)(
    'replaying with changed %s raises a correlation error identifying the mismatch',
    (field, actual) => {
      const store = openAcpStateStore({ dbPath: ':memory:' })
      try {
        store.runs.createOrGetRun(BASE)
        try {
          store.runs.createOrGetRun({ ...BASE, [field]: actual })
          throw new Error('expected conflict to be thrown')
        } catch (error) {
          expect(error).toBeInstanceOf(runRepoModule.RunCorrelationConflictError)
          const conflict = error as InstanceType<typeof runRepoModule.RunCorrelationConflictError>
          expect(conflict.runId).toBe(runRepoModule.deriveRunId(BASE.wrkfRunId))
          expect(conflict.field).toBe(field)
          expect(conflict.expected).toBe(BASE[field])
          expect(conflict.actual).toBe(actual)
        }
      } finally {
        store.close()
      }
    }
  )

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
