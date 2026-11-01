import { describe, expect, test } from 'bun:test'
import {
  freshDraftAndPressureTimeline,
  freshDraftTimeline,
  makeFakeWorkerPort,
  makeNextRaw,
  pbcFinalText,
  pressurePassText,
  pressurePassTooVagueText,
} from '../../test/fixtures/pbc-worker.js'
import { type PbcContinuationWorkerInput, runPbcContinuationWorker } from './worker.js'

// ===========================================================================
// 2. PRESSURE PHASE
// ===========================================================================

describe('runPbcContinuationWorker — pressure phase', () => {
  // ── pressure ready → pbc_final → finalize ─────────────────────────────────

  test('pressure phase finalize is applied as the pressure reviewer (role + principal_ref) and stops closed', async () => {
    // Evidence timeline already has fresh pbc_draft + pressure_pass (freshness passes)
    const port = makeFakeWorkerPort({
      // HRC writes pbc_final output in the pressure turn
      finalText: pbcFinalText('ev_draft_1', 'ev_pp_1'),
      evidence: freshDraftAndPressureTimeline(),
      nextSequence: [
        // pressure phase, finalize_ready_pbc available
        makeNextRaw({
          status: 'active',
          phase: 'pressure',
          revision: 5,
          contextHash: 'sha256:ctx5',
          actions: [{ transition: 'finalize_ready_pbc' }],
        }),
        // after evidence write
        makeNextRaw({
          status: 'active',
          phase: 'pressure',
          revision: 6,
          contextHash: 'sha256:ctx6',
          actions: [{ transition: 'finalize_ready_pbc' }],
        }),
        // post-finalize
        makeNextRaw({ status: 'closed', phase: 'finalized', revision: 7, actions: [] }),
      ],
    })

    const result = await runPbcContinuationWorker(port, {
      taskId: 'T-00001',
      idempotencyKey: 'worker-pressure-finalize',
      actor: 'agent:pbc-writer',
      pressureActor: 'agent:pressure-reviewer',
    } satisfies PbcContinuationWorkerInput)

    const applyCall = port._calls.find(
      (c) =>
        c.method === 'transition.apply' &&
        (c.params as Record<string, unknown>)['transition'] === 'finalize_ready_pbc'
    )
    expect(applyCall).toBeDefined()
    // Finalization is applied by the reviewer actor under its bound wrkf role —
    // role=agent + reviewer actor is rejected by wrkf's role-binding gate (T-03778).
    expect((applyCall?.params as Record<string, unknown>)['role']).toBe('pressure_reviewer')
    expect((applyCall?.params as Record<string, unknown>)['principal_ref']).toBe(
      'agent:pressure-reviewer'
    )
    expect(result.stopReason).toBe('closed')
  })

  test('empty final text + terminal HRC run → turn counts as complete, finalize applied (T-04024)', async () => {
    // The participant recorded evidence via direct wrkf calls but ended its turn
    // with an empty assistant message. The HRC run is COMPLETED, so the worker
    // must not wait for text that will never arrive.
    const port = makeFakeWorkerPort({
      finalText: '',
      runStatus: 'completed',
      evidence: freshDraftAndPressureTimeline(),
      nextSequence: [
        makeNextRaw({
          status: 'active',
          phase: 'pressure',
          revision: 5,
          contextHash: 'sha256:ctx5',
          actions: [{ transition: 'finalize_ready_pbc' }],
        }),
        makeNextRaw({
          status: 'active',
          phase: 'pressure',
          revision: 5,
          contextHash: 'sha256:ctx5',
          actions: [{ transition: 'finalize_ready_pbc' }],
        }),
        makeNextRaw({ status: 'closed', phase: 'finalized', revision: 6, actions: [] }),
      ],
    })

    const result = await runPbcContinuationWorker(port, {
      taskId: 'T-00001',
      idempotencyKey: 'worker-empty-text-terminal',
      actor: 'agent:pbc-writer',
      pressureActor: 'agent:pressure-reviewer',
    } satisfies PbcContinuationWorkerInput)

    const applyCall = port._calls.find(
      (c) =>
        c.method === 'transition.apply' &&
        (c.params as Record<string, unknown>)['transition'] === 'finalize_ready_pbc'
    )
    expect(applyCall).toBeDefined()
    expect(result.stopReason).toBe('closed')
    expect(result.turnsCompleted).toBeGreaterThanOrEqual(1)
  })

  test('thrown error after a completed turn reports the real turnsCompleted, not 0', async () => {
    const port = makeFakeWorkerPort({
      finalText: pbcFinalText('ev_draft_1', 'ev_pp_1'),
      evidence: freshDraftAndPressureTimeline(),
      nextSequence: [
        makeNextRaw({
          status: 'active',
          phase: 'pressure',
          revision: 5,
          contextHash: 'sha256:ctx5',
          actions: [{ transition: 'finalize_ready_pbc' }],
        }),
        makeNextRaw({
          status: 'active',
          phase: 'pressure',
          revision: 6,
          contextHash: 'sha256:ctx6',
          actions: [{ transition: 'finalize_ready_pbc' }],
        }),
      ],
      transitionShouldThrow: (transition) =>
        transition === 'finalize_ready_pbc' ? new Error('wrkf rejected transition') : undefined,
    })

    const result = await runPbcContinuationWorker(port, {
      taskId: 'T-00001',
      idempotencyKey: 'worker-turns-not-masked',
      actor: 'agent:pbc-writer',
      pressureActor: 'agent:pressure-reviewer',
    } satisfies PbcContinuationWorkerInput)

    expect(result.finalStatus).toBe('failed')
    expect(result.stopReason).toContain('wrkf rejected transition')
    // The pressure turn DID complete before the transition blew up; the
    // result must not mask that as zero turns (T-03778 secondary finding).
    expect(result.turnsCompleted).toBe(1)
  })

  // ── pressure freshness guard blocks stale finalize ─────────────────────────

  test('finalize_ready_pbc with no fresh pbc_draft is not applied and stops naming the freshness block', async () => {
    // No fresh draft in evidence timeline → freshness guard blocks finalize
    const port = makeFakeWorkerPort({
      finalText: pbcFinalText('ev_draft_old', 'ev_pp_old'),
      evidence: [], // empty timeline → no fresh draft → freshness blocked
      nextSequence: [
        makeNextRaw({
          status: 'active',
          phase: 'pressure',
          revision: 3,
          actions: [{ transition: 'finalize_ready_pbc' }],
        }),
        makeNextRaw({
          status: 'active',
          phase: 'pressure',
          revision: 4,
          actions: [{ transition: 'finalize_ready_pbc' }],
        }),
        // Still blocked
        makeNextRaw({ status: 'closed', phase: 'finalized', revision: 5, actions: [] }),
      ],
    })

    const result = await runPbcContinuationWorker(port, {
      taskId: 'T-00001',
      idempotencyKey: 'worker-pressure-stale',
      actor: 'agent:pbc-writer',
      pressureActor: 'agent:pressure-reviewer',
    } satisfies PbcContinuationWorkerInput)

    // finalize_ready_pbc must NOT have been applied (freshness blocked it)
    const finalizeApply = port._calls.find(
      (c) =>
        c.method === 'transition.apply' &&
        (c.params as Record<string, unknown>)['transition'] === 'finalize_ready_pbc'
    )
    expect(finalizeApply).toBeUndefined()
    expect(port._calls.filter((c) => c.method === 'transition.apply')).toHaveLength(0)
    expect(result.stopReason).toBe(
      'pbc freshness blocked: no fresh pbc_draft after revision boundary'
    )
  })

  // ── needs_patch → STOPS at patch_decision human gate ──────────────────────

  test('needs_patch → request_patch_decision applied → stops at patch_decision human gate', async () => {
    const port = makeFakeWorkerPort({
      finalText: pressurePassText('ev_draft_1'),
      evidence: freshDraftTimeline(),
      nextSequence: [
        // pressure: needs_patch path → request_patch_decision
        makeNextRaw({
          status: 'active',
          phase: 'pressure',
          revision: 3,
          actions: [{ transition: 'request_patch_decision' }],
        }),
        // after evidence write
        makeNextRaw({
          status: 'active',
          phase: 'pressure',
          revision: 4,
          actions: [{ transition: 'request_patch_decision' }],
        }),
        // after request_patch_decision applied: waiting/patch_decision
        makeNextRaw({
          status: 'waiting',
          phase: 'patch_decision',
          revision: 5,
          actions: [],
          openObligations: [{ id: 'obl_pd1', kind: 'patch_decision', status: 'open' }],
        }),
      ],
    })

    const result = await runPbcContinuationWorker(port, {
      taskId: 'T-00001',
      idempotencyKey: 'worker-needs-patch',
      actor: 'agent:pbc-writer',
      pressureActor: 'agent:pressure-reviewer',
    } satisfies PbcContinuationWorkerInput)

    // Worker MUST stop at patch_decision human gate
    expect(result.stopReason).toBe('requires_product_owner_patch_decision')

    // request_patch_decision was applied before stopping
    const applyCall = port._calls.find(
      (c) =>
        c.method === 'transition.apply' &&
        (c.params as Record<string, unknown>)['transition'] === 'request_patch_decision'
    )
    expect(applyCall).toBeDefined()
  })

  // ── too_vague → revise_too_vague_pbc → loops back ─────────────────────────

  test('too_vague pressure verdict applies revise_too_vague_pbc', async () => {
    const port = makeFakeWorkerPort({
      finalText: pressurePassTooVagueText('ev_draft_1'),
      evidence: freshDraftTimeline(),
      nextSequence: [
        // pressure: too_vague path → revise_too_vague_pbc
        makeNextRaw({
          status: 'active',
          phase: 'pressure',
          revision: 4,
          actions: [{ transition: 'revise_too_vague_pbc' }],
        }),
        // after evidence write
        makeNextRaw({
          status: 'active',
          phase: 'pressure',
          revision: 5,
          actions: [{ transition: 'revise_too_vague_pbc' }],
        }),
        // after revise transition: loops to pbc_draft
        makeNextRaw({
          status: 'active',
          phase: 'pbc_draft',
          revision: 6,
          actions: [{ transition: 'run_pressure_pass' }],
        }),
        // stop the loop to prevent infinite recursion in test
        makeNextRaw({ status: 'closed', phase: 'finalized', revision: 7, actions: [] }),
      ],
    })

    const result = await runPbcContinuationWorker(port, {
      taskId: 'T-00001',
      idempotencyKey: 'worker-too-vague',
      actor: 'agent:pbc-writer',
      pressureActor: 'agent:pressure-reviewer',
    } satisfies PbcContinuationWorkerInput)

    // revise_too_vague_pbc must have been applied
    const reviseApply = port._calls.find(
      (c) =>
        c.method === 'transition.apply' &&
        (c.params as Record<string, unknown>)['transition'] === 'revise_too_vague_pbc'
    )
    expect(reviseApply).toBeDefined()

    expect(
      port._calls.filter((c) => c.method === 'transition.apply').map((c) => c.params['transition'])
    ).toEqual(['revise_too_vague_pbc'])
    expect(
      port._calls.filter((c) => c.method === 'launchAcpRun').map((c) => c.params['role'])
    ).toEqual(['pressure_reviewer'])
    expect(result).toMatchObject({ stopReason: 'closed', turnsCompleted: 1, finalRevision: 7 })
  })

  // ── SoD: finalize requires distinct pressure reviewer ─────────────────────

  test('finalize blocked (not applied) when pressureActor same as actor (SoD violation)', async () => {
    const port = makeFakeWorkerPort({
      finalText: pbcFinalText('ev_draft_1', 'ev_pp_1'),
      evidence: freshDraftAndPressureTimeline(),
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
      ],
    })

    const result = await runPbcContinuationWorker(port, {
      taskId: 'T-00001',
      idempotencyKey: 'worker-sod',
      actor: 'agent:pbc-writer',
      pressureActor: 'agent:pbc-writer', // SAME as actor → SoD violation
    } satisfies PbcContinuationWorkerInput)

    // finalize_ready_pbc must NOT be applied (SoD)
    const finalizeApply = port._calls.find(
      (c) =>
        c.method === 'transition.apply' &&
        (c.params as Record<string, unknown>)['transition'] === 'finalize_ready_pbc'
    )
    expect(finalizeApply).toBeUndefined()
    expect(result.stopReason).toBe('requires_distinct_pressure_reviewer')
  })

  // ── Effects delivered after finalize ──────────────────────────────────────

  test('pending effects are each delivered once after finalize_ready_pbc is applied', async () => {
    const port = makeFakeWorkerPort({
      finalText: pbcFinalText('ev_draft_1', 'ev_pp_1'),
      evidence: freshDraftAndPressureTimeline(),
      effects: [
        { id: 'eff_finalize_1', kind: 'set_task_state', status: 'pending' },
        { id: 'eff_finalize_2', kind: 'set_task_state', status: 'pending' },
      ],
      nextSequence: [
        makeNextRaw({
          status: 'active',
          phase: 'pressure',
          revision: 5,
          actions: [{ transition: 'finalize_ready_pbc' }],
        }),
        makeNextRaw({
          status: 'active',
          phase: 'pressure',
          revision: 6,
          actions: [{ transition: 'finalize_ready_pbc' }],
        }),
        makeNextRaw({ status: 'closed', phase: 'finalized', revision: 7, actions: [] }),
      ],
    })

    await runPbcContinuationWorker(port, {
      taskId: 'T-00001',
      idempotencyKey: 'worker-finalize-effects',
      actor: 'agent:pbc-writer',
      pressureActor: 'agent:pressure-reviewer',
    } satisfies PbcContinuationWorkerInput)

    const methods = port._calls.map((c) => c.method)
    const transitionIdx = methods.indexOf('transition.apply')
    const effectListIdx = methods.indexOf('effect.list')
    const effectDeliverIdx = methods.indexOf('effect.deliver')

    expect(transitionIdx).toBeGreaterThan(-1)
    expect(effectListIdx).toBeGreaterThan(transitionIdx)
    expect(effectDeliverIdx).toBeGreaterThan(effectListIdx)
    // Each listed pending effect is delivered exactly once.
    expect(
      port._calls
        .filter((c) => c.method === 'effect.deliver')
        .map((c) => (c.params as Record<string, unknown>)['effectId'])
    ).toEqual(['eff_finalize_1', 'eff_finalize_2'])
  })
})
