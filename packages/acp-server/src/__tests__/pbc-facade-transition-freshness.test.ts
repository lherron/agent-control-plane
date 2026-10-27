/**
 * RED TESTS — PBC facade transition freshness (T-03157)
 *
 * Reproduces the stale-contextHash bug: dispose / input handlers read
 * wrkf.next (capturing contextHash) BEFORE writing evidence, then apply
 * the transition with the now-stale contextHash → 409 WRKF_CONTEXT_MISMATCH.
 *
 * ─── Key divergence from existing fakes ──────────────────────────────────────
 * The fakes in pbc-product-routes.test.ts keep contextHash constant, which
 * means transition.apply always receives the "correct" hash even though the
 * handlers read it before the evidence writes. That masking is exactly why
 * the bug passed tests while failing in production.
 *
 * These fakes BUMP contextHash (and revision) on every evidence.add and
 * obligation.satisfy call — exactly as the real wrkf binary does. With the
 * bumping fake, the current broken handler reads the stale hash, adds
 * evidence (bumps hash), then applies the transition with the stale hash →
 * the fake detects the mismatch → throws WRKF_CONTEXT_MISMATCH → handler
 * returns 409 → tests expect 200 → tests are RED.
 *
 * ─── Green path ──────────────────────────────────────────────────────────────
 * The fix must route every product-facade transition through
 * applyFreshTransition: re-read wrkf.next AFTER evidence/obligation writes,
 * apply with fresh revision/contextHash, single CAS retry on stale mismatch.
 * Once fixed, the handlers will read the bumped contextHash from the
 * post-write next() call, pass the correct hash to transition.apply, and
 * the bumping fake will accept it → 200 → tests turn GREEN.
 *
 * ─── Scope ───────────────────────────────────────────────────────────────────
 * This file is SEPARATE from pbc-product-routes.test.ts and
 * pbc-projection.test.ts (other agents edit those in parallel).
 * Only the NEW file src/__tests__/pbc-facade-transition-freshness.test.ts is
 * committed (stage only this file).
 */

import { describe, expect, test } from 'bun:test'

import { withWiredServer } from '../../test/fixtures/wired-server.js'
import type { AcpWrkfWorkflowPort } from '../wrkf/port.js'

// ─── Constants ────────────────────────────────────────────────────────────────

const TASK = 'T-09200'
const HUMAN_ACTOR = JSON.stringify({ kind: 'human', id: 'user:product-owner' })
const PBC_WORKFLOW_REF = 'pbc-progressive-refinement@9'

// ─── Bumping-fake state type ──────────────────────────────────────────────────

type FakeWrkfState = {
  revision: number
  contextHash: string
  status: string
  phase: string
  actions: Array<{ id: string; transition: string; role: string }>
  openObligations: Array<{ id: string; kind: string; status: string }>
}

type PortCall = { method: string; params: unknown }
type BumpingPort = AcpWrkfWorkflowPort & { _calls: PortCall[]; _state: FakeWrkfState }

/**
 * Build a fake wrkf port whose evidence.add and obligation.satisfy BUMP the
 * instance contextHash (and revision) — like the real wrkf binary does.
 *
 * transition.apply checks whether the provided contextHash matches the CURRENT
 * state. If stale → throws WRKF_CONTEXT_MISMATCH (the bug trigger). If fresh →
 * succeeds and bumps again. next() always returns the current live state.
 *
 * After a successful dispose_from_* transition the state transitions to
 * closed/disposed. After answer_clarification / finalize_after_patch_decision
 * the state transitions to active/behavior_note so the final readPbcNext in
 * the handler builds a valid projection.
 */
function makeBumpingPort(initial: FakeWrkfState): BumpingPort {
  // Mutable live state shared across all fake method calls.
  const state: FakeWrkfState = {
    revision: initial.revision,
    contextHash: initial.contextHash,
    status: initial.status,
    phase: initial.phase,
    actions: [...initial.actions],
    openObligations: [...initial.openObligations],
  }
  const _calls: PortCall[] = []

  function bump(): void {
    state.revision += 1
    state.contextHash = `sha256:ctx-bumped-${state.revision}`
  }

  function contextMismatchError(): Error & { code: string } {
    const error = new Error(`context hash mismatch: expected ${state.contextHash}`) as Error & {
      code: string
    }
    error.code = 'WRKF_CONTEXT_MISMATCH'
    return error
  }

  function boom(name: string): () => never {
    return (): never => {
      throw new Error(`bumping fake: ${name} must not be called in this scenario`)
    }
  }

  const port: BumpingPort = {
    _calls,
    _state: state,

    captures: {
      async get(key: string) {
        _calls.push({ method: 'captures.get', params: { key } })
        return undefined
      },
      async set(key: string, record: unknown) {
        _calls.push({ method: 'captures.set', params: { key, record } })
      },
    },

    workflow: {
      validate: boom('workflow.validate'),
      show: boom('workflow.show'),
      list: boom('workflow.list'),
      diff: boom('workflow.diff'),
      install: boom('workflow.install'),
    },

    task: {
      attach: async (params) => {
        _calls.push({ method: 'task.attach', params })
        return { task: (params as Record<string, unknown>)['task'], workflowRef: PBC_WORKFLOW_REF }
      },
      inspect: async (params) => {
        _calls.push({ method: 'task.inspect', params })
        return {
          task: {
            taskId: (params as Record<string, unknown>)['task'],
            title: 'Freshness test task',
          },
          instance: {
            id: 'inst-fresh-001',
            workflowRef: PBC_WORKFLOW_REF,
            state: { status: state.status, phase: state.phase },
            revision: state.revision,
            contextHash: state.contextHash,
          },
        }
      },
      timeline: boom('task.timeline'),
      refresh: boom('task.refresh'),
      syncMeta: boom('task.syncMeta'),
    },

    /** Always returns the CURRENT live state (including post-bump values). */
    next: async (params) => {
      _calls.push({ method: 'next', params })
      return {
        instance: {
          id: 'inst-fresh-001',
          state: { status: state.status, phase: state.phase },
          revision: state.revision,
          contextHash: state.contextHash,
        },
        actions: state.actions.map((a) => ({ id: a.id, transition: a.transition, role: a.role })),
        blockedTransitions: [],
        openObligations: state.openObligations.map((o) => ({
          id: o.id,
          kind: o.kind,
          status: o.status,
        })),
        pendingEffects: [],
      }
    },

    evidence: {
      /** BUMPS contextHash + revision on every call — like the real wrkf binary. */
      add: async (params) => {
        _calls.push({ method: 'evidence.add', params })
        bump() // ← critical: this is what the current fakes DON'T do
        return {
          id: `ev-${state.revision}`,
          kind: (params as Record<string, unknown>)['kind'],
          task: TASK,
        }
      },
      list: async (params) => {
        _calls.push({ method: 'evidence.list', params })
        return []
      },
      show: boom('evidence.show'),
      suggest: boom('evidence.suggest'),
    },

    obligation: {
      list: async (params) => {
        _calls.push({ method: 'obligation.list', params })
        return state.openObligations.map((o) => ({ id: o.id, kind: o.kind, status: o.status }))
      },
      show: boom('obligation.show'),
      /** BUMPS contextHash + revision on every call — like the real wrkf binary. */
      satisfy: async (params) => {
        _calls.push({ method: 'obligation.satisfy', params })
        bump() // ← also bumps in real wrkf
        return { id: (params as Record<string, unknown>)['id'], status: 'satisfied' }
      },
      waive: boom('obligation.waive'),
      cancel: boom('obligation.cancel'),
    },

    transition: {
      /**
       * Validates contextHash matches current live state.
       * Stale hash → WRKF_CONTEXT_MISMATCH (the bug trigger).
       * Fresh hash → success + bump + apply state changes.
       */
      apply: async (params) => {
        _calls.push({ method: 'transition.apply', params })
        const p = params as Record<string, unknown>
        const providedHash = p['contextHash']

        // Verify freshness: provided hash must match current live state.
        if (typeof providedHash === 'string' && providedHash !== state.contextHash) {
          throw contextMismatchError()
        }

        // Success: bump and advance state based on transition name.
        bump()
        const transition = typeof p['transition'] === 'string' ? p['transition'] : ''
        if (transition.startsWith('dispose_from_')) {
          state.status = 'closed'
          state.phase = 'disposed'
          state.actions = []
          state.openObligations = []
        } else if (transition === 'answer_clarification') {
          state.status = 'active'
          state.phase = 'behavior_note'
          state.openObligations = []
        } else if (transition === 'finalize_after_patch_decision') {
          state.status = 'closed'
          state.phase = 'finalized'
          state.actions = []
          state.openObligations = []
        } else if (transition === 'revise_after_patch_decision') {
          state.status = 'active'
          state.phase = 'behavior_note'
          state.openObligations = []
        }

        return {
          task: TASK,
          transition,
          revision: state.revision,
        }
      },
    },

    run: {
      start: async (params) => {
        _calls.push({ method: 'run.start', params })
        return { id: `wrkfrun-${_calls.length}`, state: 'active' }
      },
      bindExternal: boom('run.bindExternal'),
      finish: async (params) => {
        _calls.push({ method: 'run.finish', params })
        return { id: (params as Record<string, unknown>)['runId'], state: 'completed' }
      },
      fail: async (params) => {
        _calls.push({ method: 'run.fail', params })
        return { id: (params as Record<string, unknown>)['runId'], state: 'failed' }
      },
      show: boom('run.show'),
      list: boom('run.list'),
    },

    effect: {
      list: async (params) => {
        _calls.push({ method: 'effect.list', params })
        return []
      },
      show: boom('effect.show'),
      claim: boom('effect.claim'),
      ack: boom('effect.ack'),
      fail: boom('effect.fail'),
      retry: boom('effect.retry'),
      deliver: async (params) => {
        _calls.push({ method: 'effect.deliver', params })
        return { effectId: (params as Record<string, unknown>)['effectId'], status: 'delivered' }
      },
    },
  } as BumpingPort

  return port
}

// ─── Canned initial states ────────────────────────────────────────────────────

/** Active PBC task in behavior_note phase — ready for a human dispose. */
const BEHAVIOR_NOTE_STATE: FakeWrkfState = {
  revision: 3,
  contextHash: 'sha256:ctx-bn-3',
  status: 'active',
  phase: 'behavior_note',
  actions: [],
  openObligations: [],
}

/** Waiting PBC task in clarification phase — ready for clarification_response input. */
const CLARIFICATION_STATE: FakeWrkfState = {
  revision: 5,
  contextHash: 'sha256:ctx-clarif-5',
  status: 'waiting',
  phase: 'clarification',
  actions: [],
  openObligations: [{ id: 'obl-clarif-1', kind: 'clarification_response', status: 'open' }],
}

/** Waiting PBC task in patch_decision phase — ready for patch_decision input. */
const PATCH_DECISION_STATE: FakeWrkfState = {
  revision: 7,
  contextHash: 'sha256:ctx-patch-7',
  status: 'waiting',
  phase: 'patch_decision',
  actions: [],
  openObligations: [{ id: 'obl-patch-1', kind: 'patch_decision', status: 'open' }],
}

// ─────────────────────────────────────────────────────────────────────────────
// §1 — POST /v1/pbc/tasks/:taskId/dispose — survives evidence-write context bump
//
// Bug: dispose.ts reads wrkf.next (contextHash=sha256:ctx-bn-3), adds
// disposition_decision evidence (bumps to sha256:ctx-bn-4), then calls
// transition.apply with stale sha256:ctx-bn-3 → WRKF_CONTEXT_MISMATCH → 409.
//
// Fix: re-read wrkf.next AFTER evidence.add (applyFreshTransition) so the
// apply uses the bumped hash → succeeds.
// ─────────────────────────────────────────────────────────────────────────────

describe('dispose — survives evidence-write context bump', () => {
  test.each([
    { phase: 'behavior_note', state: BEHAVIOR_NOTE_STATE },
    // A human can dispose from ANY non-terminal phase, including while waiting
    // for clarification (dispose_from_clarification).
    { phase: 'clarification', state: CLARIFICATION_STATE },
  ])(
    'dispose from $phase after the evidence write bumps the wrkf context hash still returns the 200 projection (no stale-hash 409)',
    async ({ phase, state }) => {
      const wrkf = makeBumpingPort(state)

      await withWiredServer(
        async (fixture) => {
          const response = await fixture.request({
            method: 'POST',
            path: `/v1/pbc/tasks/${TASK}/dispose`,
            headers: { 'x-acp-actor': HUMAN_ACTOR },
            body: {
              idempotencyKey: `dispose-freshness-${phase}`,
              resolution: 'abandoned',
              reason: 'Scope dropped from sprint',
            },
          })

          // A handler that applies the transition with the contextHash captured
          // before evidence.add gets WRKF_CONTEXT_MISMATCH from the bumping fake → 409.
          expect(response.status).toBe(200)
          const body = await fixture.json<Record<string, unknown>>(response)
          expect(body['source']).toBe('wrkf')
          expect(body['taskId']).toBe(TASK)
          expect(body['workflowRef']).toBe(PBC_WORKFLOW_REF)
          expect((body['diagnostics'] as Record<string, unknown>)['pack']).toBe('pbc')

          const apply = wrkf._calls.find((c) => c.method === 'transition.apply')
          expect((apply?.params as Record<string, unknown>)['transition']).toBe(
            `dispose_from_${phase}`
          )
        },
        { wrkf }
      )
    }
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// §2 — POST /v1/pbc/tasks/:taskId/input clarification_response — survives bump
//
// Bug: input.ts read wrkf.next, added clarification_response evidence (bump),
// satisfied the obligation (bump again), then applied the transition with the
// original stale contextHash → 409. Fix: re-read wrkf.next after the writes.
// ─────────────────────────────────────────────────────────────────────────────

describe('input clarification_response — survives evidence+obligation context bump', () => {
  test('clarification answer after evidence and obligation writes bump the context hash still returns the 200 projection', async () => {
    const wrkf = makeBumpingPort(CLARIFICATION_STATE)

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/input`,
          headers: { 'x-acp-actor': HUMAN_ACTOR },
          body: {
            idempotencyKey: 'input-clarif-freshness-001',
            kind: 'clarification_response',
            data: { answer: 'Double-click the save button to submit' },
          },
        })

        expect(response.status).toBe(200)
        const body = await fixture.json<Record<string, unknown>>(response)
        expect(body['source']).toBe('wrkf')
        expect(body['taskId']).toBe(TASK)
        expect(body['workflowRef']).toBe(PBC_WORKFLOW_REF)

        // Evidence is written before the transition, and the transition applied
        // is answer_clarification.
        const methods = wrkf._calls.map((c) => c.method)
        const evidenceIdx = methods.indexOf('evidence.add')
        const applyIdx = methods.indexOf('transition.apply')
        expect(evidenceIdx).toBeGreaterThan(-1)
        expect(applyIdx).toBeGreaterThan(evidenceIdx)
        expect((wrkf._calls[applyIdx]!.params as Record<string, unknown>)['transition']).toBe(
          'answer_clarification'
        )
      },
      { wrkf }
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §3 — POST /v1/pbc/tasks/:taskId/input patch_decision — survives bump
//
// Same bug as clarification_response but on the patch_decision screen.
// ─────────────────────────────────────────────────────────────────────────────

describe('input patch_decision — survives evidence+obligation context bump', () => {
  test.each([
    { route: 'finalize', transition: 'finalize_after_patch_decision' },
    { route: 'revise', transition: 'revise_after_patch_decision' },
  ])(
    'patch decision ($route) after context-hash bumps returns the 200 projection and applies $transition',
    async ({ route, transition }) => {
      const wrkf = makeBumpingPort(PATCH_DECISION_STATE)

      await withWiredServer(
        async (fixture) => {
          const response = await fixture.request({
            method: 'POST',
            path: `/v1/pbc/tasks/${TASK}/input`,
            headers: { 'x-acp-actor': HUMAN_ACTOR },
            body: {
              idempotencyKey: `input-patch-${route}-freshness-001`,
              kind: 'patch_decision',
              data: { route },
            },
          })

          expect(response.status).toBe(200)
          const body = await fixture.json<Record<string, unknown>>(response)
          expect(body['source']).toBe('wrkf')
          expect(body['taskId']).toBe(TASK)
          expect(body['workflowRef']).toBe(PBC_WORKFLOW_REF)
          expect((body['diagnostics'] as Record<string, unknown>)['pack']).toBe('pbc')

          const apply = wrkf._calls.find((c) => c.method === 'transition.apply')
          expect((apply?.params as Record<string, unknown>)['transition']).toBe(transition)
        },
        { wrkf }
      )
    }
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// §4 — Fake correctness guard: bumping fake DOES reject stale contextHash
//
// These tests verify the fake itself is working correctly: if a caller
// deliberately passes the stale contextHash to transition.apply, the fake
// throws WRKF_CONTEXT_MISMATCH. This confirms the fake faithfully models
// the real wrkf behavior that the bug exposes.
// ─────────────────────────────────────────────────────────────────────────────

describe('bumping fake correctness — transition.apply rejects stale contextHash', () => {
  test('fake rejects stale contextHash after evidence.add bumps it', async () => {
    const initial: FakeWrkfState = {
      revision: 2,
      contextHash: 'sha256:stale-initial',
      status: 'active',
      phase: 'behavior_note',
      actions: [],
      openObligations: [],
    }
    const wrkf = makeBumpingPort(initial)

    // Capture the stale hash before any evidence.add.
    const staleCaptured = initial.contextHash

    // Simulate evidence.add (bumps contextHash).
    await wrkf.evidence.add({ task: TASK, kind: 'test_evidence' })

    // Trying to apply with the old (stale) hash should throw WRKF_CONTEXT_MISMATCH.
    let threw = false
    let thrownCode = ''
    try {
      await wrkf.transition.apply({
        task: TASK,
        transition: 'dispose_from_behavior_note',
        expectRevision: initial.revision,
        contextHash: staleCaptured, // stale!
      })
    } catch (error) {
      threw = true
      thrownCode = (error as { code?: string }).code ?? ''
    }

    expect(threw).toBe(true)
    expect(thrownCode).toBe('WRKF_CONTEXT_MISMATCH')
  })

  test('fake accepts fresh contextHash from next() after evidence.add', async () => {
    const initial: FakeWrkfState = {
      revision: 2,
      contextHash: 'sha256:fresh-initial',
      status: 'active',
      phase: 'behavior_note',
      actions: [],
      openObligations: [],
    }
    const wrkf = makeBumpingPort(initial)

    // Simulate evidence.add (bumps contextHash).
    await wrkf.evidence.add({ task: TASK, kind: 'test_evidence' })

    // Re-read next() to get the post-bump contextHash.
    const freshNext = await wrkf.next({ task: TASK, role: 'agent' })
    const freshHash = (
      (freshNext as Record<string, unknown>)['instance'] as Record<string, unknown>
    )['contextHash'] as string

    // Applying with the fresh hash should succeed.
    let threw = false
    try {
      await wrkf.transition.apply({
        task: TASK,
        transition: 'dispose_from_behavior_note',
        expectRevision: initial.revision + 1,
        contextHash: freshHash,
      })
    } catch {
      threw = true
    }

    expect(threw).toBe(false)
    expect(freshHash).not.toBe(initial.contextHash)
  })
})
