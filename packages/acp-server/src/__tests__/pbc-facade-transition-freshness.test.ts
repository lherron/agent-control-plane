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
const PBC_WORKFLOW_REF = 'pbc-progressive-refinement@5'

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
    const error = new Error(
      `context hash mismatch: expected ${state.contextHash}`
    ) as Error & { code: string }
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
          task: { taskId: (params as Record<string, unknown>)['task'], title: 'Freshness test task' },
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
        openObligations: state.openObligations.map((o) => ({ id: o.id, kind: o.kind, status: o.status })),
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

describe('dispose — survives evidence-write context bump (RED)', () => {
  test('[RED] human dispose on behavior_note phase succeeds (not 409) when evidence.add bumps contextHash', async () => {
    const wrkf = makeBumpingPort(BEHAVIOR_NOTE_STATE)

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/dispose`,
          headers: { 'x-acp-actor': HUMAN_ACTOR },
          body: {
            idempotencyKey: 'dispose-freshness-001',
            resolution: 'abandoned',
            reason: 'Scope dropped from sprint',
          },
        })

        // RED: currently fails with 409 (WRKF_CONTEXT_MISMATCH) because the
        // handler applies the transition with a stale contextHash captured before
        // the evidence.add call. Fix: re-read wrkf.next after evidence.add.
        expect(response.status).toBe(200)
        const body = await fixture.json<Record<string, unknown>>(response)
        expect(body['source']).toBe('wrkf')
        expect(body['taskId']).toBe(TASK)
        expect(body['workflowRef']).toBe(PBC_WORKFLOW_REF)
      },
      { wrkf }
    )
  })

  test('[RED] dispose transition.apply receives the POST-evidence-write contextHash (not pre-write stale)', async () => {
    const wrkf = makeBumpingPort(BEHAVIOR_NOTE_STATE)

    // The pre-write contextHash (stale, should NOT be used by a fixed handler).
    const staleContextHash = BEHAVIOR_NOTE_STATE.contextHash

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/dispose`,
          headers: { 'x-acp-actor': HUMAN_ACTOR },
          body: {
            idempotencyKey: 'dispose-freshness-ctx-check-001',
            resolution: 'abandoned',
            reason: 'Out of scope',
          },
        })

        // RED: currently 409 because handler uses stale contextHash.
        // After fix: 200, and the contextHash passed to transition.apply
        // must be the POST-bump value, not the pre-bump stale value.
        expect(response.status).toBe(200)

        const applyCall = wrkf._calls.find((c) => c.method === 'transition.apply')
        expect(applyCall).toBeDefined()
        const applyParams = applyCall!.params as Record<string, unknown>

        // The apply call must NOT use the stale pre-evidence-write contextHash.
        expect(applyParams['contextHash']).not.toBe(staleContextHash)

        // It must have used the bumped hash (sha256:ctx-bumped-4 = after revision 3 + 1 bump).
        // More broadly, it must be a different (newer) hash than the stale one.
        expect(typeof applyParams['contextHash']).toBe('string')
      },
      { wrkf }
    )
  })

  test('[RED] human dispose on clarification phase (waiting) succeeds despite context bump', async () => {
    // A human can dispose from ANY non-terminal phase, including while the task
    // is waiting for clarification. The transition is dispose_from_clarification.
    const wrkf = makeBumpingPort(CLARIFICATION_STATE)

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/dispose`,
          headers: { 'x-acp-actor': HUMAN_ACTOR },
          body: {
            idempotencyKey: 'dispose-freshness-clarif-001',
            resolution: 'abandoned',
            reason: 'No longer needed',
          },
        })

        // RED: currently 409 WRKF_CONTEXT_MISMATCH (stale hash after evidence.add).
        expect(response.status).toBe(200)
      },
      { wrkf }
    )
  })

  test('[RED] dispose response projection source is wrkf and taskId matches', async () => {
    const wrkf = makeBumpingPort(BEHAVIOR_NOTE_STATE)

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/dispose`,
          headers: { 'x-acp-actor': HUMAN_ACTOR },
          body: {
            idempotencyKey: 'dispose-freshness-shape-001',
            resolution: 'abandoned',
            reason: 'Scope change',
          },
        })

        // RED: currently 409 instead of 200 with a valid PbcTaskProjection.
        expect(response.status).toBe(200)
        const body = await fixture.json<Record<string, unknown>>(response)

        // Projection shape contract.
        expect(body['source']).toBe('wrkf')
        expect(body['taskId']).toBe(TASK)
        expect(body['workflowRef']).toBe(PBC_WORKFLOW_REF)
        expect(body['instance']).toBeDefined()
        expect(body['screen']).toBeDefined()
        expect(body['diagnostics']).toBeDefined()
        const diagnostics = body['diagnostics'] as Record<string, unknown>
        expect(diagnostics['pack']).toBe('pbc')
      },
      { wrkf }
    )
  })

  test('[RED] dispose disposition_decision evidence is added before transition.apply', async () => {
    const wrkf = makeBumpingPort(BEHAVIOR_NOTE_STATE)

    await withWiredServer(
      async (fixture) => {
        await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/dispose`,
          headers: { 'x-acp-actor': HUMAN_ACTOR },
          body: {
            idempotencyKey: 'dispose-freshness-order-001',
            resolution: 'abandoned',
            reason: 'Test ordering',
          },
        })

        // Whether 200 or 409, we can assert ordering of calls.
        // Evidence must be added BEFORE transition.apply is attempted.
        const methods = wrkf._calls.map((c) => c.method)
        const evidenceIdx = methods.indexOf('evidence.add')
        const applyIdx = methods.indexOf('transition.apply')

        expect(evidenceIdx).toBeGreaterThan(-1)
        // If apply was attempted, it must come after evidence.
        if (applyIdx >= 0) {
          expect(applyIdx).toBeGreaterThan(evidenceIdx)
        }
      },
      { wrkf }
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §2 — POST /v1/pbc/tasks/:taskId/input clarification_response — survives bump
//
// Bug: input.ts reads wrkf.next (contextHash=sha256:ctx-clarif-5), adds
// clarification_response evidence (bumps to sha256:ctx-bumped-6), satisfies
// the obligation (bumps again to sha256:ctx-bumped-7), then calls
// transition.apply with the original stale sha256:ctx-clarif-5 → 409.
//
// Fix: re-read wrkf.next AFTER evidence/obligation writes.
// ─────────────────────────────────────────────────────────────────────────────

describe('input clarification_response — survives evidence+obligation context bump (RED)', () => {
  test('[RED] human clarification_response input succeeds (not 409) when writes bump contextHash', async () => {
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

        // RED: currently 409 (WRKF_CONTEXT_MISMATCH) because the handler
        // applies the transition with the contextHash captured BEFORE evidence.add
        // and obligation.satisfy, both of which bump the hash.
        expect(response.status).toBe(200)
        const body = await fixture.json<Record<string, unknown>>(response)
        expect(body['source']).toBe('wrkf')
        expect(body['taskId']).toBe(TASK)
      },
      { wrkf }
    )
  })

  test('[RED] clarification_response: transition.apply receives post-write contextHash', async () => {
    const wrkf = makeBumpingPort(CLARIFICATION_STATE)

    const staleContextHash = CLARIFICATION_STATE.contextHash

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/input`,
          headers: { 'x-acp-actor': HUMAN_ACTOR },
          body: {
            idempotencyKey: 'input-clarif-ctx-check-001',
            kind: 'clarification_response',
            data: { answer: 'Use the keyboard shortcut Ctrl+S' },
          },
        })

        // RED: 409 currently.
        expect(response.status).toBe(200)

        const applyCall = wrkf._calls.find((c) => c.method === 'transition.apply')
        expect(applyCall).toBeDefined()
        const applyParams = applyCall!.params as Record<string, unknown>

        // Must NOT be the stale pre-write contextHash.
        expect(applyParams['contextHash']).not.toBe(staleContextHash)
      },
      { wrkf }
    )
  })

  test('[RED] clarification_response input returns PbcTaskProjection on success', async () => {
    const wrkf = makeBumpingPort(CLARIFICATION_STATE)

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/input`,
          headers: { 'x-acp-actor': HUMAN_ACTOR },
          body: {
            idempotencyKey: 'input-clarif-proj-001',
            kind: 'clarification_response',
            data: { answer: 'The upload button triggers the file picker' },
          },
        })

        // RED: currently 409; after fix: 200 with full projection.
        expect(response.status).toBe(200)
        const body = await fixture.json<Record<string, unknown>>(response)

        expect(body['source']).toBe('wrkf')
        expect(body['taskId']).toBe(TASK)
        expect(body['workflowRef']).toBe(PBC_WORKFLOW_REF)
        expect(body['instance']).toBeDefined()
        expect(Array.isArray(body['actions'])).toBe(true)
        expect(body['diagnostics']).toBeDefined()
      },
      { wrkf }
    )
  })

  test('[RED] clarification_response: answer_clarification transition is applied (not rejected)', async () => {
    const wrkf = makeBumpingPort(CLARIFICATION_STATE)

    await withWiredServer(
      async (fixture) => {
        await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/input`,
          headers: { 'x-acp-actor': HUMAN_ACTOR },
          body: {
            idempotencyKey: 'input-clarif-apply-check-001',
            kind: 'clarification_response',
            data: { answer: 'Double-click the submit button' },
          },
        })

        // Evidence must be written before the transition apply attempt.
        const methods = wrkf._calls.map((c) => c.method)
        const evidenceIdx = methods.indexOf('evidence.add')
        const applyIdx = methods.indexOf('transition.apply')

        expect(evidenceIdx).toBeGreaterThan(-1)
        if (applyIdx >= 0) {
          expect(applyIdx).toBeGreaterThan(evidenceIdx)
          const applyCall = wrkf._calls[applyIdx]
          const transition = (applyCall!.params as Record<string, unknown>)['transition']
          expect(String(transition)).toContain('answer_clarification')
        }
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

describe('input patch_decision — survives evidence+obligation context bump (RED)', () => {
  test('[RED] human patch_decision input (finalize route) succeeds when writes bump contextHash', async () => {
    const wrkf = makeBumpingPort(PATCH_DECISION_STATE)

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/input`,
          headers: { 'x-acp-actor': HUMAN_ACTOR },
          body: {
            idempotencyKey: 'input-patch-finalize-freshness-001',
            kind: 'patch_decision',
            data: { route: 'finalize' },
          },
        })

        // RED: currently 409 (stale contextHash after evidence.add bumps it).
        expect(response.status).toBe(200)
        const body = await fixture.json<Record<string, unknown>>(response)
        expect(body['source']).toBe('wrkf')
        expect(body['taskId']).toBe(TASK)
      },
      { wrkf }
    )
  })

  test('[RED] human patch_decision input (revise route) succeeds when writes bump contextHash', async () => {
    const wrkf = makeBumpingPort(PATCH_DECISION_STATE)

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/input`,
          headers: { 'x-acp-actor': HUMAN_ACTOR },
          body: {
            idempotencyKey: 'input-patch-revise-freshness-001',
            kind: 'patch_decision',
            data: { route: 'revise' },
          },
        })

        // RED: currently 409 (stale contextHash after evidence.add bumps it).
        expect(response.status).toBe(200)
        const body = await fixture.json<Record<string, unknown>>(response)
        expect(body['source']).toBe('wrkf')
        expect(body['taskId']).toBe(TASK)
      },
      { wrkf }
    )
  })

  test('[RED] patch_decision: transition.apply receives post-write contextHash', async () => {
    const wrkf = makeBumpingPort(PATCH_DECISION_STATE)

    const staleContextHash = PATCH_DECISION_STATE.contextHash

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/input`,
          headers: { 'x-acp-actor': HUMAN_ACTOR },
          body: {
            idempotencyKey: 'input-patch-ctx-check-001',
            kind: 'patch_decision',
            data: { route: 'finalize' },
          },
        })

        // RED: 409 currently.
        expect(response.status).toBe(200)

        const applyCall = wrkf._calls.find((c) => c.method === 'transition.apply')
        expect(applyCall).toBeDefined()
        const applyParams = applyCall!.params as Record<string, unknown>

        // Must NOT be the stale pre-write contextHash.
        expect(applyParams['contextHash']).not.toBe(staleContextHash)
      },
      { wrkf }
    )
  })

  test('[RED] patch_decision returns PbcTaskProjection after successful input', async () => {
    const wrkf = makeBumpingPort(PATCH_DECISION_STATE)

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/input`,
          headers: { 'x-acp-actor': HUMAN_ACTOR },
          body: {
            idempotencyKey: 'input-patch-proj-001',
            kind: 'patch_decision',
            data: { route: 'finalize' },
          },
        })

        // RED: currently 409; after fix: 200 with full projection.
        expect(response.status).toBe(200)
        const body = await fixture.json<Record<string, unknown>>(response)

        expect(body['source']).toBe('wrkf')
        expect(body['taskId']).toBe(TASK)
        expect(body['workflowRef']).toBe(PBC_WORKFLOW_REF)
        expect(body['diagnostics']).toBeDefined()
        const diagnostics = body['diagnostics'] as Record<string, unknown>
        expect(diagnostics['pack']).toBe('pbc')
      },
      { wrkf }
    )
  })
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
    const freshHash = ((freshNext as Record<string, unknown>)['instance'] as Record<string, unknown>)['contextHash'] as string

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
