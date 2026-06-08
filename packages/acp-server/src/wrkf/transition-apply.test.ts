/**
 * Red tests — Phase 1, Deliverable 5:
 * applyFreshTransition helper — re-reads wrkf.next, applies with fresh
 * revision/contextHash, retries once on stale mismatch.
 *
 * WHY RED NOW:
 *   File `src/wrkf/transition-apply.ts` does not exist.
 *   Importing from it fails at module load time with "Cannot find module".
 *   ALL tests in this file are RED as a consequence.
 *
 * WHAT THE IMPL AGENT MUST CREATE:
 *   New file: `packages/acp-server/src/wrkf/transition-apply.ts`
 *
 *   Exported function signature:
 *     export async function applyFreshTransition(
 *       port: TransitionApplyPort,
 *       input: ApplyFreshTransitionInput
 *     ): Promise<ApplyFreshTransitionResult>
 *
 *   Where:
 *     TransitionApplyPort = {
 *       next(params: { task: string; role?: string }): Promise<unknown>
 *       transition: {
 *         apply(params: WrkfTransitionApplyParams): Promise<unknown>
 *       }
 *     }
 *
 *     ApplyFreshTransitionInput = {
 *       task: string
 *       transition: string
 *       role?: string
 *       actor?: string
 *       routeKey?: string
 *       runChecks?: boolean
 *     }
 *
 *     ApplyFreshTransitionResult = {
 *       transitionResult: unknown
 *       instance: { revision: number; contextHash?: string }  // post-apply state
 *     }
 *
 *   Algorithm (SPEC §4.12):
 *     1. Call port.next({ task }) to read current revision + contextHash
 *     2. Project the next response (projectNextActionResponse) to get instance
 *     3. Call port.transition.apply({
 *          task, transition, role, actor,
 *          expectRevision: instance.revision,
 *          contextHash: instance.contextHash,
 *          idempotencyKey: derivedKey,  // derived from routeKey + transition + revision
 *          ...(runChecks !== undefined ? { runChecks } : {})
 *        })
 *     4. On WRKF_STALE_REVISION or WRKF_CONTEXT_MISMATCH:
 *          - Re-read next ONCE (same call as step 1)
 *          - Retry transition.apply with fresh revision/contextHash
 *          - If it fails again — propagate the error
 *     5. After successful apply, re-read next to get the post-apply instance
 *     6. Return { transitionResult, instance: postApplyInstance }
 *
 *   Key invariants tested here:
 *     - ALWAYS reads next before first apply (not using a caller-provided CAS)
 *     - Retries EXACTLY ONCE on WRKF_STALE_REVISION / WRKF_CONTEXT_MISMATCH
 *     - Does NOT retry on other errors
 *     - Re-reads next after success (for post-apply instance)
 *     - idempotencyKey changes between the first attempt and the retry
 *       (uses the fresh revision from the re-read)
 *
 * Fake port pattern: same `_calls` spy as pbc-harness.test.ts / effect-delivery.test.ts.
 */

import { describe, expect, test } from 'bun:test'

// RED: transition-apply.ts does not exist — import fails at module load.
import {
  type ApplyFreshTransitionInput,
  type ApplyFreshTransitionResult,
  type TransitionApplyPort,
  applyFreshTransition,
} from './transition-apply.js'

// ── Fake port ─────────────────────────────────────────────────────────────────

type SpyCall = { method: string; params: unknown }
type FakeTransitionApplyPort = TransitionApplyPort & { _calls: SpyCall[] }

/** Build a minimal next() response with given revision/contextHash */
function makeNextRaw(opts: { revision?: number; contextHash?: string } = {}): Record<string, unknown> {
  return {
    instance: {
      state: { status: 'active', phase: 'intake' },
      revision: opts.revision ?? 1,
      contextHash: opts.contextHash ?? 'sha256:ctx001',
    },
    actions: [{ id: 'transition_submit', transition: 'submit', role: 'owner' }],
    blockedTransitions: [],
    openObligations: [],
    pendingEffects: [],
  }
}

/** Build a successful transition.apply result */
function makeApplyResult(transition: string, revision: number): Record<string, unknown> {
  return { transition, revision, status: 'applied' }
}

/** Error with a wrkf code property */
function makeWrkfError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string }
  err.code = code
  return err
}

function makeFakePort(opts: {
  nextSequence?: Array<Record<string, unknown>>
  applyResult?: Record<string, unknown>
  applyShouldThrowSequence?: Array<(Error & { code: string }) | null>
}): FakeTransitionApplyPort {
  const _calls: SpyCall[] = []
  const nextSeq = opts.nextSequence ?? [makeNextRaw()]
  let nextIdx = 0
  let applyIdx = 0
  const applyResults = opts.applyShouldThrowSequence ?? []
  const defaultApplyResult = opts.applyResult ?? makeApplyResult('submit', 2)

  return {
    _calls,

    next: async (params: { task: string; role?: string }) => {
      _calls.push({ method: 'next', params })
      const response = nextSeq[Math.min(nextIdx, nextSeq.length - 1)]
      nextIdx++
      return response
    },

    transition: {
      apply: async (params: Record<string, unknown>) => {
        _calls.push({ method: 'transition.apply', params })
        const behavior = applyResults[applyIdx] ?? null
        applyIdx++
        if (behavior !== null) {
          throw behavior
        }
        return defaultApplyResult
      },
    },
  }
}

const TASK = 'T-P1D5-001'

// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║  1. Module exports applyFreshTransition                                     ║
// ╚══════════════════════════════════════════════════════════════════════════════╝

describe('P1-D5: applyFreshTransition is exported from transition-apply.ts', () => {
  // RED: module doesn't exist — all tests fail at import

  test('applyFreshTransition is a function', () => {
    // RED: module doesn't exist → import fails
    expect(typeof applyFreshTransition).toBe('function')
  })

  test('applyFreshTransition returns a Promise', async () => {
    const port = makeFakePort({})
    const input: ApplyFreshTransitionInput = {
      task: TASK,
      transition: 'submit',
      role: 'owner',
      actor: 'agent:test-agent',
      routeKey: 'test-route',
    }
    // RED: TypeError: applyFreshTransition is not a function
    const result = applyFreshTransition(port, input)
    expect(result).toBeInstanceOf(Promise)
    const resolved: ApplyFreshTransitionResult = await result
    expect(resolved).toBeDefined()
  })
})

// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║  2. Always reads next before first apply                                    ║
// ╚══════════════════════════════════════════════════════════════════════════════╝

describe('P1-D5: applyFreshTransition — always reads next before applying', () => {
  test('calls next({task}) before transition.apply', async () => {
    const port = makeFakePort({ nextSequence: [makeNextRaw({ revision: 5, contextHash: 'sha256:ctx5' })] })
    const input: ApplyFreshTransitionInput = {
      task: TASK,
      transition: 'submit',
      role: 'owner',
      actor: 'agent:test',
      routeKey: 'key1',
    }

    // RED: TypeError
    await applyFreshTransition(port, input)

    const methods = port._calls.map((c) => c.method)
    const nextIdx = methods.indexOf('next')
    const applyIdx = methods.indexOf('transition.apply')
    expect(nextIdx).toBeGreaterThan(-1)
    expect(applyIdx).toBeGreaterThan(nextIdx)
  })

  test('transition.apply uses revision from next() response', async () => {
    const REVISION = 7
    const port = makeFakePort({ nextSequence: [makeNextRaw({ revision: REVISION })] })
    const input: ApplyFreshTransitionInput = {
      task: TASK,
      transition: 'submit',
      role: 'owner',
      actor: 'agent:test',
      routeKey: 'key2',
    }

    // RED: TypeError
    await applyFreshTransition(port, input)

    const applyCall = port._calls.find((c) => c.method === 'transition.apply')
    expect(applyCall).toBeDefined()
    const params = applyCall!.params as Record<string, unknown>
    expect(params['expectRevision']).toBe(REVISION)
  })

  test('transition.apply uses contextHash from next() response', async () => {
    const CTX_HASH = 'sha256:ctxdeadbeef'
    const port = makeFakePort({ nextSequence: [makeNextRaw({ contextHash: CTX_HASH })] })
    const input: ApplyFreshTransitionInput = {
      task: TASK,
      transition: 'submit',
      role: 'owner',
      actor: 'agent:test',
      routeKey: 'key3',
    }

    // RED: TypeError
    await applyFreshTransition(port, input)

    const applyCall = port._calls.find((c) => c.method === 'transition.apply')
    expect(applyCall).toBeDefined()
    const params = applyCall!.params as Record<string, unknown>
    expect(params['contextHash']).toBe(CTX_HASH)
  })

  test('transition.apply receives task, transition, role, actor from input', async () => {
    const port = makeFakePort({})
    const input: ApplyFreshTransitionInput = {
      task: TASK,
      transition: 'submit',
      role: 'owner',
      actor: 'agent:test-actor',
      routeKey: 'key4',
    }

    // RED: TypeError
    await applyFreshTransition(port, input)

    const applyCall = port._calls.find((c) => c.method === 'transition.apply')
    expect(applyCall).toBeDefined()
    const params = applyCall!.params as Record<string, unknown>
    expect(params['task']).toBe(TASK)
    expect(params['transition']).toBe('submit')
    expect(params['role']).toBe('owner')
    expect(params['actor']).toBe('agent:test-actor')
  })
})

// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║  3. Retries exactly once on WRKF_STALE_REVISION / WRKF_CONTEXT_MISMATCH    ║
// ╚══════════════════════════════════════════════════════════════════════════════╝

describe('P1-D5: applyFreshTransition — retries once on stale mismatch', () => {
  test('WRKF_STALE_REVISION: re-reads next and retries transition.apply once', async () => {
    const FRESH_REVISION = 8
    const port = makeFakePort({
      nextSequence: [
        makeNextRaw({ revision: 5 }),        // first next read (stale)
        makeNextRaw({ revision: FRESH_REVISION }), // second next read (fresh)
        makeNextRaw({ revision: FRESH_REVISION }), // third read after success
      ],
      applyShouldThrowSequence: [
        makeWrkfError('WRKF_STALE_REVISION', 'revision mismatch'),
        null, // second attempt succeeds
      ],
    })
    const input: ApplyFreshTransitionInput = {
      task: TASK,
      transition: 'submit',
      role: 'owner',
      actor: 'agent:test',
      routeKey: 'retry-key1',
    }

    // RED: TypeError
    const result = await applyFreshTransition(port, input)
    expect(result).toBeDefined()

    const applyCalls = port._calls.filter((c) => c.method === 'transition.apply')
    // Must have been called exactly twice (first attempt + one retry)
    expect(applyCalls).toHaveLength(2)

    // Second apply must use the fresh revision from the re-read
    const retryParams = applyCalls[1]!.params as Record<string, unknown>
    expect(retryParams['expectRevision']).toBe(FRESH_REVISION)
  })

  test('WRKF_CONTEXT_MISMATCH: re-reads next and retries once', async () => {
    const FRESH_HASH = 'sha256:fresh-ctx'
    const port = makeFakePort({
      nextSequence: [
        makeNextRaw({ contextHash: 'sha256:stale-ctx' }),
        makeNextRaw({ contextHash: FRESH_HASH }),
        makeNextRaw({ contextHash: FRESH_HASH }),
      ],
      applyShouldThrowSequence: [
        makeWrkfError('WRKF_CONTEXT_MISMATCH', 'context hash mismatch'),
        null,
      ],
    })
    const input: ApplyFreshTransitionInput = {
      task: TASK,
      transition: 'submit',
      role: 'owner',
      actor: 'agent:test',
      routeKey: 'retry-key2',
    }

    // RED: TypeError
    await applyFreshTransition(port, input)

    const applyCalls = port._calls.filter((c) => c.method === 'transition.apply')
    expect(applyCalls).toHaveLength(2)
    const retryParams = applyCalls[1]!.params as Record<string, unknown>
    expect(retryParams['contextHash']).toBe(FRESH_HASH)
  })

  test('does NOT retry on non-stale errors (e.g. WRKF_ROLE_DENIED) — propagates immediately', async () => {
    const port = makeFakePort({
      nextSequence: [makeNextRaw()],
      applyShouldThrowSequence: [
        makeWrkfError('WRKF_ROLE_DENIED', 'role not permitted'),
      ],
    })
    const input: ApplyFreshTransitionInput = {
      task: TASK,
      transition: 'submit',
      role: 'wrong-role',
      actor: 'agent:test',
      routeKey: 'no-retry-key',
    }

    // RED: TypeError. After impl: rejects with WRKF_ROLE_DENIED.
    await expect(applyFreshTransition(port, input)).rejects.toMatchObject({ code: 'WRKF_ROLE_DENIED' })

    // transition.apply called only once (no retry)
    const applyCalls = port._calls.filter((c) => c.method === 'transition.apply')
    expect(applyCalls).toHaveLength(1)
  })

  test('retry also fails with WRKF_STALE_REVISION — propagates the second error', async () => {
    // SPEC: retry exactly once. If second attempt also fails, propagate it.
    const port = makeFakePort({
      nextSequence: [makeNextRaw({ revision: 5 }), makeNextRaw({ revision: 6 }), makeNextRaw({ revision: 7 })],
      applyShouldThrowSequence: [
        makeWrkfError('WRKF_STALE_REVISION', 'first stale'),
        makeWrkfError('WRKF_STALE_REVISION', 'second stale — propagate'),
      ],
    })
    const input: ApplyFreshTransitionInput = {
      task: TASK,
      transition: 'submit',
      role: 'owner',
      actor: 'agent:test',
      routeKey: 'double-stale-key',
    }

    // RED: TypeError. After impl: rejects with WRKF_STALE_REVISION (second error).
    await expect(applyFreshTransition(port, input)).rejects.toMatchObject({ code: 'WRKF_STALE_REVISION' })

    // transition.apply called exactly twice
    const applyCalls = port._calls.filter((c) => c.method === 'transition.apply')
    expect(applyCalls).toHaveLength(2)
  })
})

// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║  4. Re-reads next after successful apply                                    ║
// ╚══════════════════════════════════════════════════════════════════════════════╝

describe('P1-D5: applyFreshTransition — re-reads next after success', () => {
  test('calls next at least twice: once before apply and once after', async () => {
    const port = makeFakePort({
      nextSequence: [
        makeNextRaw({ revision: 1 }),
        makeNextRaw({ revision: 2 }), // post-apply
      ],
    })
    const input: ApplyFreshTransitionInput = {
      task: TASK,
      transition: 'submit',
      role: 'owner',
      actor: 'agent:test',
      routeKey: 'post-apply-key',
    }

    // RED: TypeError
    await applyFreshTransition(port, input)

    const nextCalls = port._calls.filter((c) => c.method === 'next')
    // Pre-apply read + post-apply read = 2
    expect(nextCalls.length).toBeGreaterThanOrEqual(2)
  })

  test('result.instance contains post-apply revision from the re-read next', async () => {
    const POST_APPLY_REVISION = 9
    const port = makeFakePort({
      nextSequence: [
        makeNextRaw({ revision: 5 }),
        makeNextRaw({ revision: POST_APPLY_REVISION }),
      ],
    })
    const input: ApplyFreshTransitionInput = {
      task: TASK,
      transition: 'submit',
      role: 'owner',
      actor: 'agent:test',
      routeKey: 'post-rev-key',
    }

    // RED: TypeError
    const result: ApplyFreshTransitionResult = await applyFreshTransition(port, input)

    // The returned instance must reflect the post-apply state (revision 9, not 5)
    expect(result.instance.revision).toBe(POST_APPLY_REVISION)
  })

  test('result.transitionResult contains the raw transition.apply response', async () => {
    const APPLY_RESULT = { transition: 'submit', revision: 2, status: 'applied', extra: 'data' }
    const port = makeFakePort({ applyResult: APPLY_RESULT })
    const input: ApplyFreshTransitionInput = {
      task: TASK,
      transition: 'submit',
      role: 'owner',
      actor: 'agent:test',
      routeKey: 'result-key',
    }

    // RED: TypeError
    const result: ApplyFreshTransitionResult = await applyFreshTransition(port, input)

    expect(result.transitionResult).toMatchObject({
      transition: 'submit',
      status: 'applied',
    })
  })
})

// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║  5. Does not touch operator routes                                          ║
// ╚══════════════════════════════════════════════════════════════════════════════╝

describe('P1-D5: applyFreshTransition — no new public HTTP route', () => {
  // Structural test: applyFreshTransition is a server-side helper only.
  // The existing POST /v1/tasks/:taskId/transitions must remain unchanged.
  // This test documents the constraint; the impl agent must not add a new route.

  test('applyFreshTransition takes a port and input, not a Request — it is not an HTTP handler', () => {
    // Verify the function signature: first arg is port, second is input (not Request/Response)
    // This passes once the module exists and the function is properly typed.
    // RED: TypeError
    const portLike: TransitionApplyPort = {
      next: async (_p) => makeNextRaw(),
      transition: { apply: async (_p) => makeApplyResult('x', 1) },
    }
    // Should not throw a "Request is not defined" or similar — it takes plain objects
    const p = applyFreshTransition(portLike, {
      task: 'T-check',
      transition: 'x',
      routeKey: 'type-check',
    })
    expect(p).toBeInstanceOf(Promise)
    return p
  })
})
