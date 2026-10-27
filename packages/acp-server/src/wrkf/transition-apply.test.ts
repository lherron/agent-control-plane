/**
 * applyFreshTransition — re-reads wrkf.next, applies with the fresh
 * revision/contextHash, retries exactly once on a stale CAS mismatch.
 *
 * Callers: the PBC start/input/dispose routes (src/pbc/*.ts). The behavior a
 * caller can observe is the transition.apply RPC sent to the wrkf daemon; the
 * fake port below records it at that boundary. Route-level coverage of the
 * stale-contextHash case lives in
 * src/__tests__/pbc-facade-transition-freshness.test.ts; the revision CAS and
 * the single bounded retry are only covered here (rewrite-held: a route test
 * needs a wrkf fake that fails once).
 *
 * SPEC §4.12:
 *   1. next({ task }) → current revision + contextHash
 *   2. transition.apply({ task, transition, role, principal_ref,
 *        expectRevision, contextHash, idempotencyKey })
 *   3. WRKF_STALE_REVISION / WRKF_CONTEXT_MISMATCH → re-read next ONCE and retry
 *      with the fresh revision/contextHash (and a fresh idempotencyKey); a
 *      second failure propagates. Other errors propagate immediately.
 */

import { describe, expect, test } from 'bun:test'

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
function makeNextRaw(
  opts: { revision?: number; contextHash?: string } = {}
): Record<string, unknown> {
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

function applyParams(port: FakeTransitionApplyPort): Array<Record<string, unknown>> {
  return port._calls
    .filter((c) => c.method === 'transition.apply')
    .map((c) => c.params as Record<string, unknown>)
}

describe('P1-D5: applyFreshTransition — always reads next before applying', () => {
  test('transition.apply carries the input identity and the revision/contextHash read from next() first', async () => {
    const port = makeFakePort({
      nextSequence: [makeNextRaw({ revision: 7, contextHash: 'sha256:ctxdeadbeef' })],
    })
    const input: ApplyFreshTransitionInput = {
      task: TASK,
      transition: 'submit',
      role: 'owner',
      actor: 'agent:test-actor',
      routeKey: 'key2',
    }

    await applyFreshTransition(port, input)

    // next is read before the first apply
    const methods = port._calls.map((c) => c.method)
    expect(methods.indexOf('next')).toBeGreaterThan(-1)
    expect(methods.indexOf('transition.apply')).toBeGreaterThan(methods.indexOf('next'))

    expect(applyParams(port)).toEqual([
      {
        task: TASK,
        transition: 'submit',
        role: 'owner',
        principal_ref: 'agent:test-actor',
        expectRevision: 7,
        contextHash: 'sha256:ctxdeadbeef',
        idempotencyKey: 'key2:transition:submit:7',
      },
    ])
  })
})

describe('P1-D5: applyFreshTransition — retries once on stale mismatch', () => {
  test.each([{ code: 'WRKF_STALE_REVISION' }, { code: 'WRKF_CONTEXT_MISMATCH' }])(
    '$code: re-reads next and retries transition.apply once with the fresh revision and contextHash',
    async ({ code }) => {
      const port = makeFakePort({
        nextSequence: [
          makeNextRaw({ revision: 5, contextHash: 'sha256:stale-ctx' }), // first read (stale)
          makeNextRaw({ revision: 8, contextHash: 'sha256:fresh-ctx' }), // re-read (fresh)
          makeNextRaw({ revision: 9, contextHash: 'sha256:after' }), // read after success
        ],
        applyShouldThrowSequence: [makeWrkfError(code, 'stale'), null],
      })

      await applyFreshTransition(port, {
        task: TASK,
        transition: 'submit',
        role: 'owner',
        actor: 'agent:test',
        routeKey: 'retry-key',
      })

      const applies = applyParams(port)
      expect(applies).toHaveLength(2)
      expect(applies[0]).toMatchObject({ expectRevision: 5, contextHash: 'sha256:stale-ctx' })
      expect(applies[1]).toMatchObject({
        expectRevision: 8,
        contextHash: 'sha256:fresh-ctx',
        idempotencyKey: 'retry-key:transition:submit:8',
      })
    }
  )

  test('does NOT retry on non-stale errors (e.g. WRKF_ROLE_DENIED) — propagates immediately', async () => {
    const port = makeFakePort({
      nextSequence: [makeNextRaw()],
      applyShouldThrowSequence: [makeWrkfError('WRKF_ROLE_DENIED', 'role not permitted')],
    })
    const input: ApplyFreshTransitionInput = {
      task: TASK,
      transition: 'submit',
      role: 'wrong-role',
      actor: 'agent:test',
      routeKey: 'no-retry-key',
    }

    await expect(applyFreshTransition(port, input)).rejects.toMatchObject({
      code: 'WRKF_ROLE_DENIED',
    })

    // transition.apply called only once (no retry)
    expect(applyParams(port)).toHaveLength(1)
  })

  test('retry also fails with WRKF_STALE_REVISION — propagates the second error', async () => {
    // SPEC: retry exactly once. If second attempt also fails, propagate it.
    const port = makeFakePort({
      nextSequence: [
        makeNextRaw({ revision: 5 }),
        makeNextRaw({ revision: 6 }),
        makeNextRaw({ revision: 7 }),
      ],
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

    // Both errors share the code; the message tells the second one apart.
    await expect(applyFreshTransition(port, input)).rejects.toMatchObject({
      code: 'WRKF_STALE_REVISION',
      message: 'second stale — propagate',
    })

    // transition.apply called exactly twice
    expect(applyParams(port)).toHaveLength(2)
  })
})

describe('post-apply return contract', () => {
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
      nextSequence: [makeNextRaw({ revision: 5 }), makeNextRaw({ revision: POST_APPLY_REVISION })],
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
