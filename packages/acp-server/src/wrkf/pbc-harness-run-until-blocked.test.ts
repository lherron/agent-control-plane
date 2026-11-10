// PBC run-until-blocked contract exercised through the real ACP HTTP router.
import { describe, expect, test } from 'bun:test'

import { makeFakePort, makeNextRaw } from '../../test/fixtures/pbc-harness-port.js'
import { runUntilBlockedRoute } from '../../test/fixtures/pbc-harness-routes.js'
import { makeEvidenceRecord as makeEvidenceSnapshot } from '../../test/fixtures/pbc-worker.js'
import type { RunUntilBlockedRequest } from './pbc-harness.js'

describe('runUntilBlocked', () => {
  // ── closed: stop immediately ───────────────────────────────────────────────

  test('stops immediately when instance is already closed', async () => {
    const port = makeFakePort({
      nextSequence: [
        makeNextRaw({ status: 'closed', phase: 'finalized', revision: 10, actions: [] }),
      ],
    })
    const result = await runUntilBlockedRoute(port, {
      task: 'T-00001',
      actor: 'agent:pbc-writer',
      idempotencyKey: 'autopilot-1',
    } satisfies RunUntilBlockedRequest)

    expect(result.stopReason).toBe('closed')
    expect(result.workflowRef).toBe('pbc-progressive-refinement@9')
    // No run.start when instance is already closed
    expect(port._calls.find((c) => c.method === 'run.start')).toBeUndefined()
  })

  // ── stale flag is diagnostics-only ────────────────────────────────────────

  test('ignores next.instance.stale and uses the real blocking reason', async () => {
    const port = makeFakePort({
      nextSequence: [
        makeNextRaw({
          status: 'open',
          phase: 'intake',
          revision: 1,
          stale: true,
          actions: [],
        }),
      ],
    })
    const result = await runUntilBlockedRoute(port, {
      task: 'T-00001',
      actor: 'agent:pbc-writer',
      idempotencyKey: 'autopilot-stale',
      maxTurns: 1,
    } satisfies RunUntilBlockedRequest)

    expect(result.stopReason).toBe('blocked_or_ambiguous')
    expect(result.instance.stale).toBe(true)
  })

  // ── max_turns ─────────────────────────────────────────────────────────────

  test('stops at maxTurns and returns max_turns stop reason', async () => {
    // Always return a legal action so autopilot never blocks
    const alwaysNext = makeNextRaw({
      status: 'open',
      phase: 'intake',
      revision: 0,
      actions: [{ transition: 'normalize_feedback' }],
    })
    const port = makeFakePort({
      nextSequence: Array.from({ length: 20 }, () => alwaysNext),
    })

    const result = await runUntilBlockedRoute(port, {
      task: 'T-00001',
      actor: 'agent:pbc-writer',
      idempotencyKey: 'autopilot-maxturn',
      maxTurns: 2,
    } satisfies RunUntilBlockedRequest)

    expect(result.stopReason).toBe('max_turns')
  })

  // ── requires_product_owner_clarification ───────────────────────────────────

  test('stops with requires_product_owner_clarification in waiting/clarification without simulation', async () => {
    const port = makeFakePort({
      nextSequence: [
        makeNextRaw({
          status: 'waiting',
          phase: 'clarification',
          revision: 3,
          actions: [],
          openObligations: [{ id: 'obl_001', kind: 'clarification_response', status: 'open' }],
        }),
      ],
    })
    const result = await runUntilBlockedRoute(port, {
      task: 'T-00001',
      actor: 'agent:pbc-writer',
      idempotencyKey: 'autopilot-clarif',
    } satisfies RunUntilBlockedRequest)

    expect(result.stopReason).toBe('requires_product_owner_clarification')
  })

  // ── requires_product_owner_patch_decision ──────────────────────────────────

  test('stops with requires_product_owner_patch_decision in waiting/patch_decision without simulation', async () => {
    const port = makeFakePort({
      nextSequence: [
        makeNextRaw({
          status: 'waiting',
          phase: 'patch_decision',
          revision: 5,
          actions: [],
          openObligations: [{ id: 'obl_002', kind: 'patch_decision', status: 'open' }],
        }),
      ],
    })
    const result = await runUntilBlockedRoute(port, {
      task: 'T-00001',
      actor: 'agent:pbc-writer',
      idempotencyKey: 'autopilot-patch',
    } satisfies RunUntilBlockedRequest)

    expect(result.stopReason).toBe('requires_product_owner_patch_decision')
  })

  // ── blocked_or_ambiguous ──────────────────────────────────────────────────

  test('stops with blocked_or_ambiguous when no single safe transition can be chosen', async () => {
    const port = makeFakePort({
      nextSequence: [
        // Initial next
        makeNextRaw({
          status: 'active',
          phase: 'behavior_note',
          revision: 2,
          actions: [{ transition: 'ask_clarification' }, { transition: 'draft_pbc' }],
        }),
        // After evidence ingest (still ambiguous)
        makeNextRaw({
          status: 'active',
          phase: 'behavior_note',
          revision: 3,
          actions: [{ transition: 'ask_clarification' }, { transition: 'draft_pbc' }],
        }),
      ],
    })
    const result = await runUntilBlockedRoute(port, {
      task: 'T-00001',
      actor: 'agent:pbc-writer',
      idempotencyKey: 'autopilot-ambig',
      maxTurns: 1,
    } satisfies RunUntilBlockedRequest)

    expect(result.stopReason).toBe('blocked_or_ambiguous')
  })

  // ── requires_distinct_pressure_reviewer (SoD violation) ───────────────────

  test('stops with requires_distinct_pressure_reviewer when pressure and draft actor are same', async () => {
    // State is active/pressure: autopilot would try finalize_ready_pbc with verdict=ready
    // but draft actor === pressure actor → SoD violation
    const port = makeFakePort({
      nextSequence: [
        makeNextRaw({
          status: 'active',
          phase: 'pressure',
          revision: 4,
          actions: [{ transition: 'finalize_ready_pbc' }],
        }),
        // After evidence ingest
        makeNextRaw({
          status: 'active',
          phase: 'pressure',
          revision: 5,
          actions: [{ transition: 'finalize_ready_pbc' }],
        }),
      ],
    })

    // Same actor for draft and pressure — SoD violation
    const result = await runUntilBlockedRoute(port, {
      task: 'T-00001',
      actor: 'agent:pbc-writer', // same actor for both roles
      pressureActor: 'agent:pbc-writer', // SAME as actor → SoD violation
      idempotencyKey: 'autopilot-sod',
    } satisfies RunUntilBlockedRequest)

    expect(result.stopReason).toBe('requires_distinct_pressure_reviewer')
  })

  test('does NOT stop for SoD when pressureActor differs from draft actor', async () => {
    // Provide distinct actors; autopilot should apply finalize_ready_pbc
    const port = makeFakePort({
      evidence: [
        makeEvidenceSnapshot('ev_draft_1', 'pbc_draft'),
        makeEvidenceSnapshot('ev_pp_1', 'pressure_pass', {
          facts: { verdict: 'ready' },
          data: { reviewedDraftEvidenceId: 'ev_draft_1' },
        }),
        makeEvidenceSnapshot('ev_final_1', 'pbc_final', {
          data: {
            basedOnDraftEvidenceId: 'ev_draft_1',
            basedOnPressurePassEvidenceId: 'ev_pp_1',
          },
        }),
      ],
      nextSequence: [
        makeNextRaw({
          status: 'active',
          phase: 'pressure',
          revision: 4,
          actions: [{ transition: 'finalize_ready_pbc' }],
        }),
        makeNextRaw({
          status: 'active',
          phase: 'pressure',
          revision: 5,
          actions: [{ transition: 'finalize_ready_pbc' }],
        }),
        // After transition, closed
        makeNextRaw({
          status: 'closed',
          phase: 'finalized',
          revision: 6,
          actions: [],
        }),
      ],
    })

    const result = await runUntilBlockedRoute(port, {
      task: 'T-00001',
      actor: 'agent:pbc-writer',
      pressureActor: 'agent:pressure-reviewer', // distinct
      idempotencyKey: 'autopilot-sod-ok',
      maxTurns: 5,
    } satisfies RunUntilBlockedRequest)

    // Finalizes and stops as closed, not as an SoD violation
    expect(result.stopReason).toBe('closed')
    const finalizeCall = port._calls.find(
      (c) =>
        c.method === 'transition.apply' &&
        (c.params as Record<string, unknown>)['transition'] === 'finalize_ready_pbc'
    )
    expect(finalizeCall).toBeDefined()
  })

  // ── Disposition gating ────────────────────────────────────────────────────

  test('does NOT choose dispose_from_behavior_note without allowDisposition=true', async () => {
    const port = makeFakePort({
      nextSequence: [
        makeNextRaw({
          status: 'active',
          phase: 'behavior_note',
          revision: 2,
          actions: [{ transition: 'dispose_from_behavior_note' }],
        }),
        // After run step (still only disposition available)
        makeNextRaw({
          status: 'active',
          phase: 'behavior_note',
          revision: 3,
          actions: [{ transition: 'dispose_from_behavior_note' }],
        }),
      ],
    })

    const result = await runUntilBlockedRoute(port, {
      task: 'T-00001',
      actor: 'agent:pbc-writer',
      idempotencyKey: 'autopilot-disp',
      maxTurns: 1,
    } satisfies RunUntilBlockedRequest)

    // Must stop rather than apply a disposition without explicit approval
    expect(result.stopReason).toBe('blocked_or_ambiguous')
    const dispositionCall = port._calls.find(
      (c) =>
        c.method === 'transition.apply' &&
        (c.params as Record<string, unknown>)['transition'] === 'dispose_from_behavior_note'
    )
    expect(dispositionCall).toBeUndefined()
  })

  test('applies dispose_from_behavior_note when allowDisposition=true', async () => {
    const port = makeFakePort({
      nextSequence: [
        makeNextRaw({
          status: 'active',
          phase: 'behavior_note',
          revision: 2,
          actions: [{ transition: 'dispose_from_behavior_note' }],
        }),
        makeNextRaw({
          status: 'active',
          phase: 'behavior_note',
          revision: 3,
          actions: [{ transition: 'dispose_from_behavior_note' }],
        }),
        makeNextRaw({
          status: 'closed',
          phase: 'disposed',
          revision: 4,
          actions: [],
        }),
      ],
    })

    const result = await runUntilBlockedRoute(port, {
      task: 'T-00001',
      actor: 'agent:pbc-writer',
      idempotencyKey: 'autopilot-disp-ok',
      allowDisposition: true,
      maxTurns: 3,
    } satisfies RunUntilBlockedRequest)

    const dispositionCall = port._calls.find(
      (c) =>
        c.method === 'transition.apply' &&
        (c.params as Record<string, unknown>)['transition'] === 'dispose_from_behavior_note'
    )
    expect(dispositionCall).toBeDefined()
    expect(result.stopReason).toBe('closed')
  })

  // ── Obligation before transition: clarification path ──────────────────────

  test('obligation.satisfy called before answer_clarification transition', async () => {
    const port = makeFakePort({
      nextSequence: [
        makeNextRaw({
          status: 'waiting',
          phase: 'clarification',
          revision: 3,
          actions: [{ transition: 'answer_clarification' }],
          openObligations: [{ id: 'obl_clarifA', kind: 'clarification_response', status: 'open' }],
        }),
        // Re-read by the evidence writer after the obligation is satisfied
        makeNextRaw({
          status: 'waiting',
          phase: 'clarification',
          revision: 4,
          actions: [{ transition: 'answer_clarification' }],
          openObligations: [],
        }),
        // Fresh read the autopilot chooses from
        makeNextRaw({
          status: 'waiting',
          phase: 'clarification',
          revision: 4,
          actions: [{ transition: 'answer_clarification' }],
          openObligations: [],
        }),
        // After transition
        makeNextRaw({
          status: 'closed',
          phase: 'finalized',
          revision: 5,
          actions: [],
        }),
      ],
      obligations: [{ id: 'obl_clarifA', kind: 'clarification_response', status: 'open' }],
    })

    const result = await runUntilBlockedRoute(port, {
      task: 'T-00001',
      actor: 'agent:pbc-writer',
      idempotencyKey: 'autopilot-clarif-ob',
      allowProductOwnerSimulation: true,
      maxTurns: 3,
    } satisfies RunUntilBlockedRequest)

    const callMethods = port._calls.map((c) => c.method)
    const satisfyIdx = callMethods.lastIndexOf('obligation.satisfy')
    const applyIdx = callMethods.lastIndexOf('transition.apply')

    // obligation.satisfy must come BEFORE transition.apply for answer_clarification
    expect(applyIdx).toBeGreaterThan(-1)
    expect((port._calls[applyIdx]!.params as Record<string, unknown>)['transition']).toBe(
      'answer_clarification'
    )
    expect(satisfyIdx).toBeGreaterThan(-1)
    expect(satisfyIdx).toBeLessThan(applyIdx)
    expect(result.stopReason).toBe('closed')
  })

  test('obligation.satisfy called before patch-decision transitions (patch_decision path)', async () => {
    const port = makeFakePort({
      // Fresh draft -> pressure pass -> final chain so finalization passes freshness;
      // the simulated patch_decision (route=finalize) is appended by the autopilot.
      evidence: [
        makeEvidenceSnapshot('ev_draft_1', 'pbc_draft'),
        makeEvidenceSnapshot('ev_pp_1', 'pressure_pass', {
          facts: { verdict: 'needs_patch' },
          data: { reviewedDraftEvidenceId: 'ev_draft_1' },
        }),
        makeEvidenceSnapshot('ev_final_1', 'pbc_final', {
          data: {
            basedOnDraftEvidenceId: 'ev_draft_1',
            basedOnPressurePassEvidenceId: 'ev_pp_1',
          },
        }),
      ],
      nextSequence: [
        makeNextRaw({
          status: 'waiting',
          phase: 'patch_decision',
          revision: 5,
          actions: [{ transition: 'finalize_after_patch_decision' }],
          openObligations: [{ id: 'obl_patchB', kind: 'patch_decision', status: 'open' }],
        }),
        // Re-read by the evidence writer after the obligation is satisfied
        makeNextRaw({
          status: 'waiting',
          phase: 'patch_decision',
          revision: 6,
          actions: [{ transition: 'finalize_after_patch_decision' }],
          openObligations: [],
        }),
        // Fresh read the autopilot chooses from
        makeNextRaw({
          status: 'waiting',
          phase: 'patch_decision',
          revision: 6,
          actions: [{ transition: 'finalize_after_patch_decision' }],
          openObligations: [],
        }),
        makeNextRaw({
          status: 'closed',
          phase: 'finalized',
          revision: 7,
          actions: [],
        }),
      ],
      obligations: [{ id: 'obl_patchB', kind: 'patch_decision', status: 'open' }],
    })

    const result = await runUntilBlockedRoute(port, {
      task: 'T-00001',
      actor: 'agent:pbc-writer',
      pressureActor: 'agent:pressure-reviewer',
      idempotencyKey: 'autopilot-patch-ob',
      allowProductOwnerSimulation: true,
      maxTurns: 4,
    } satisfies RunUntilBlockedRequest)

    const callMethods = port._calls.map((c) => c.method)
    const satisfyIdx = callMethods.lastIndexOf('obligation.satisfy')
    const applyIdx = callMethods.lastIndexOf('transition.apply')
    expect(applyIdx).toBeGreaterThan(-1)
    expect((port._calls[applyIdx]!.params as Record<string, unknown>)['transition']).toBe(
      'finalize_after_patch_decision'
    )
    expect(satisfyIdx).toBeGreaterThan(-1)
    expect(satisfyIdx).toBeLessThan(applyIdx)
    expect(result.stopReason).toBe('closed')
  })

  // ── Re-read next after every write ────────────────────────────────────────

  test('re-reads next after evidence ingest before applying transition', async () => {
    const port = makeFakePort({
      nextSequence: [
        // Initial next
        makeNextRaw({
          status: 'open',
          phase: 'intake',
          revision: 0,
          contextHash: 'sha256:ctx0',
          actions: [{ transition: 'normalize_feedback' }],
        }),
        // After evidence add (fresh contextHash)
        makeNextRaw({
          status: 'open',
          phase: 'intake',
          revision: 1,
          contextHash: 'sha256:ctx1',
          actions: [{ transition: 'normalize_feedback' }],
        }),
        // Post-transition
        makeNextRaw({
          status: 'closed',
          phase: 'finalized',
          revision: 2,
          actions: [],
        }),
      ],
    })

    await runUntilBlockedRoute(port, {
      task: 'T-00001',
      actor: 'agent:pbc-writer',
      idempotencyKey: 'autopilot-reread',
      maxTurns: 3,
    } satisfies RunUntilBlockedRequest)

    // open/intake applies normalize_feedback, using the contextHash from the
    // re-read next (sha256:ctx1, not sha256:ctx0)
    const applyCall = port._calls.find((c) => c.method === 'transition.apply')
    expect(applyCall).toBeDefined()
    const params = applyCall!.params as Record<string, unknown>
    expect(params['transition']).toBe('normalize_feedback')
    expect(params['contextHash']).toBe('sha256:ctx1')
    expect(params['expectRevision']).toBe(1)
  })

  // ── set_task_state delivery: list then deliver(effectId) ─────────────────

  test('effect delivery calls effect.list then effect.deliver for each pending effect', async () => {
    const port = makeFakePort({
      nextSequence: [
        makeNextRaw({
          status: 'open',
          phase: 'intake',
          revision: 0,
          actions: [{ transition: 'normalize_feedback' }],
        }),
        makeNextRaw({
          status: 'open',
          phase: 'intake',
          revision: 1,
          actions: [{ transition: 'normalize_feedback' }],
        }),
        makeNextRaw({
          status: 'closed',
          phase: 'finalized',
          revision: 2,
          actions: [],
        }),
      ],
      effects: [{ id: 'eff_set_1', kind: 'set_task_state', status: 'pending' }],
    })

    await runUntilBlockedRoute(port, {
      task: 'T-00001',
      actor: 'agent:pbc-writer',
      idempotencyKey: 'autopilot-deliver',
      maxTurns: 4,
    } satisfies RunUntilBlockedRequest)

    const listCall = port._calls.find((c) => c.method === 'effect.list')
    expect(listCall).toBeDefined()

    const deliverCall = port._calls.find((c) => c.method === 'effect.deliver')
    expect(deliverCall).toBeDefined()
    const deliverParams = deliverCall!.params as Record<string, unknown>
    // NEVER passes task to effect.deliver — only effectId + adapter
    expect(deliverParams['effectId']).toBe('eff_set_1')
    expect(deliverParams['adapter']).toBe('acp')
    expect(deliverParams['task']).toBeUndefined()
  })
})
