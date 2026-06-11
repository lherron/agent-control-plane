/**
 * Red tests for src/wrkf/packs/pbc/freshness.ts (Phase 5a, T-02627).
 *
 * Module under test: src/wrkf/packs/pbc/freshness.ts (NOT YET IMPLEMENTED — all tests RED)
 *
 * ─── CONTRACT ─────────────────────────────────────────────────────────────────
 *
 *   checkPbcFreshness(input: {
 *     evidenceTimeline: PbcEvidenceSnapshot[]  // ordered oldest → newest
 *     transition: string
 *   }): PbcFreshnessResult
 *
 *   PbcFreshnessResult:
 *     | { blocked: false }
 *     | { blocked: true; reason: string }
 *
 * Invariants enforced (Spec §Critical freshness guard, lines 719-744):
 *
 *   1. Revision boundary: the most recent pressure_pass(verdict=too_vague) or
 *      patch_decision(route=revise) in the evidence timeline is the latest
 *      revision boundary for the current cycle.
 *
 *   2. run_pressure_pass: the latest pbc_draft in the timeline MUST have been
 *      written AFTER the revision boundary (stale pre-revise drafts ineligible).
 *
 *   3. finalize_ready_pbc / finalize_after_patch_decision:
 *      pressure_pass.data.reviewedDraftEvidenceId MUST equal the current eligible
 *      pbc_draft id (i.e. the latest draft after the boundary).
 *
 *   4. finalize_ready_pbc: if pbc_final is present in the timeline,
 *      pbc_final.data.basedOnDraftEvidenceId MUST equal the current eligible
 *      pbc_draft id.
 *
 *   5. finalize_ready_pbc: if pbc_final is present in the timeline,
 *      pbc_final.data.basedOnPressurePassEvidenceId MUST equal the current
 *      eligible pressure_pass id.
 *
 *   6. finalize_after_patch_decision: after a patch revise boundary, the most
 *      recent patch_decision in the post-boundary window MUST have route=finalize.
 *      Old pre-boundary route=finalize decisions cannot be reused for a later draft.
 *
 * All tests are RED: the import fails until freshness.ts is implemented.
 *
 * ─── STYLE ────────────────────────────────────────────────────────────────────
 * Pure-function tests — no fake port needed. Build timeline snapshots directly.
 * Matches existing packs/pbc/*.test.ts style.
 */

import { describe, expect, test } from 'bun:test'

// These imports define the module contract. They will fail until the module exists.
import {
  type PbcEvidenceSnapshot,
  type PbcFreshnessResult,
  checkPbcFreshness,
} from './freshness.js'

// ---------------------------------------------------------------------------
// Snapshot builders
// ---------------------------------------------------------------------------

function draft(id: string): PbcEvidenceSnapshot {
  return { id, kind: 'pbc_draft' }
}

function pressurePass(
  id: string,
  opts: {
    verdict?: 'ready' | 'needs_patch' | 'too_vague'
    reviewedDraftEvidenceId?: string
  } = {}
): PbcEvidenceSnapshot {
  return {
    id,
    kind: 'pressure_pass',
    facts: { verdict: opts.verdict ?? 'ready' },
    ...(opts.reviewedDraftEvidenceId !== undefined
      ? { data: { reviewedDraftEvidenceId: opts.reviewedDraftEvidenceId } }
      : {}),
  }
}

function patchDecision(id: string, route: 'finalize' | 'revise'): PbcEvidenceSnapshot {
  return { id, kind: 'patch_decision', facts: { route } }
}

function pbcFinal(
  id: string,
  opts: {
    basedOnDraftEvidenceId?: string
    basedOnPressurePassEvidenceId?: string
  } = {}
): PbcEvidenceSnapshot {
  const data: Record<string, string> = {}
  if (opts.basedOnDraftEvidenceId !== undefined) {
    data['basedOnDraftEvidenceId'] = opts.basedOnDraftEvidenceId
  }
  if (opts.basedOnPressurePassEvidenceId !== undefined) {
    data['basedOnPressurePassEvidenceId'] = opts.basedOnPressurePassEvidenceId
  }
  return { id, kind: 'pbc_final', data }
}

/** Convenience: assert blocked=true and extract reason. */
function assertBlocked(
  result: PbcFreshnessResult
): asserts result is { blocked: true; reason: string } {
  expect(result.blocked).toBe(true)
}

// ===========================================================================
// Invariant 2: run_pressure_pass — draft must be after revision boundary
// ===========================================================================

describe('run_pressure_pass freshness (Invariant 2)', () => {
  test('BLOCKED: pbc_draft predates too_vague revise boundary, no fresh draft exists', () => {
    // too_vague boundary fires after pressure_pass with verdict=too_vague.
    // No new pbc_draft has been written after that boundary.
    const timeline: PbcEvidenceSnapshot[] = [
      draft('ev_draft_old'),
      pressurePass('ev_pp_too_vague', { verdict: 'too_vague' }),
      // ← revision boundary here; no pbc_draft follows
    ]

    const result = checkPbcFreshness({
      evidenceTimeline: timeline,
      transition: 'run_pressure_pass',
    })

    assertBlocked(result)
    expect(result.reason).toMatch(/stale|pre.?revise|boundary|fresh.*draft|draft.*fresh/i)
  })

  test('BLOCKED: pbc_draft predates patch-revise boundary, no fresh draft exists', () => {
    const timeline: PbcEvidenceSnapshot[] = [
      draft('ev_draft_old'),
      pressurePass('ev_pp_1', { verdict: 'needs_patch', reviewedDraftEvidenceId: 'ev_draft_old' }),
      patchDecision('ev_pd_revise', 'revise'), // patch revise = revision boundary
      // ← no new pbc_draft after this boundary
    ]

    const result = checkPbcFreshness({
      evidenceTimeline: timeline,
      transition: 'run_pressure_pass',
    })

    assertBlocked(result)
    expect(result.reason).toMatch(/stale|pre.?revise|boundary|fresh.*draft|draft.*fresh/i)
  })

  test('OK: fresh draft exists after too_vague revise boundary', () => {
    const timeline: PbcEvidenceSnapshot[] = [
      draft('ev_draft_old'),
      pressurePass('ev_pp_too_vague', { verdict: 'too_vague' }),
      draft('ev_draft_fresh'), // fresh draft written after the boundary
    ]

    const result = checkPbcFreshness({
      evidenceTimeline: timeline,
      transition: 'run_pressure_pass',
    })

    expect(result.blocked).toBe(false)
  })

  test('OK: initial draft before any revision boundary', () => {
    const timeline: PbcEvidenceSnapshot[] = [
      draft('ev_draft_initial'),
      // no revision boundary yet — first cycle
    ]

    const result = checkPbcFreshness({
      evidenceTimeline: timeline,
      transition: 'run_pressure_pass',
    })

    expect(result.blocked).toBe(false)
  })
})

// ===========================================================================
// Invariant 3: finalize_ready_pbc — pressure_pass.reviewedDraftEvidenceId must match
// ===========================================================================

describe('finalize_ready_pbc stale pressure_pass (Invariant 3)', () => {
  test('BLOCKED: pressure_pass.data.reviewedDraftEvidenceId does not match current eligible draft', () => {
    // pressure_pass references a different (older) draft id
    const timeline: PbcEvidenceSnapshot[] = [
      draft('ev_draft_current'),
      pressurePass('ev_pp_stale', {
        verdict: 'ready',
        reviewedDraftEvidenceId: 'ev_draft_STALE', // points at non-existent/old draft
      }),
    ]

    const result = checkPbcFreshness({
      evidenceTimeline: timeline,
      transition: 'finalize_ready_pbc',
    })

    assertBlocked(result)
    expect(result.reason).toMatch(/stale|mismatch|reviewed.*draft|draft.*reviewed/i)
  })

  test('OK: pressure_pass.data.reviewedDraftEvidenceId matches current eligible draft', () => {
    const timeline: PbcEvidenceSnapshot[] = [
      draft('ev_draft_1'),
      pressurePass('ev_pp_1', {
        verdict: 'ready',
        reviewedDraftEvidenceId: 'ev_draft_1', // correct — points at the current draft
      }),
    ]

    const result = checkPbcFreshness({
      evidenceTimeline: timeline,
      transition: 'finalize_ready_pbc',
    })

    expect(result.blocked).toBe(false)
  })

  test('BLOCKED: pressure_pass references a draft that predates too_vague revise boundary', () => {
    // After a too_vague revise, a new draft was written — the pressure_pass still
    // references the PRE-revise draft id.
    const timeline: PbcEvidenceSnapshot[] = [
      draft('ev_draft_1'),
      pressurePass('ev_pp_too_vague', { verdict: 'too_vague' }),
      draft('ev_draft_2'), // new eligible draft
      pressurePass('ev_pp_2', {
        verdict: 'ready',
        reviewedDraftEvidenceId: 'ev_draft_1', // STALE: points at pre-revise draft
      }),
    ]

    const result = checkPbcFreshness({
      evidenceTimeline: timeline,
      transition: 'finalize_ready_pbc',
    })

    assertBlocked(result)
  })
})

// ===========================================================================
// Invariant 4: pbc_final.data.basedOnDraftEvidenceId must match current draft
// ===========================================================================

describe('finalize_ready_pbc stale pbc_final draft reference (Invariant 4)', () => {
  test('BLOCKED: pbc_final.data.basedOnDraftEvidenceId does not match current eligible draft', () => {
    const timeline: PbcEvidenceSnapshot[] = [
      draft('ev_draft_1'),
      pressurePass('ev_pp_1', {
        verdict: 'ready',
        reviewedDraftEvidenceId: 'ev_draft_1',
      }),
      pbcFinal('ev_final_1', {
        basedOnDraftEvidenceId: 'ev_draft_STALE', // wrong — should be ev_draft_1
        basedOnPressurePassEvidenceId: 'ev_pp_1',
      }),
    ]

    const result = checkPbcFreshness({
      evidenceTimeline: timeline,
      transition: 'finalize_ready_pbc',
    })

    assertBlocked(result)
    expect(result.reason).toMatch(/stale|mismatch|based.*draft|draft.*based/i)
  })
})

// ===========================================================================
// Invariant 5: pbc_final.data.basedOnPressurePassEvidenceId must match current pp
// ===========================================================================

describe('finalize_ready_pbc stale pbc_final pressure_pass reference (Invariant 5)', () => {
  test('BLOCKED: pbc_final.data.basedOnPressurePassEvidenceId does not match current pressure_pass', () => {
    const timeline: PbcEvidenceSnapshot[] = [
      draft('ev_draft_1'),
      pressurePass('ev_pp_1', {
        verdict: 'ready',
        reviewedDraftEvidenceId: 'ev_draft_1',
      }),
      pbcFinal('ev_final_1', {
        basedOnDraftEvidenceId: 'ev_draft_1',
        basedOnPressurePassEvidenceId: 'ev_pp_STALE', // wrong — should be ev_pp_1
      }),
    ]

    const result = checkPbcFreshness({
      evidenceTimeline: timeline,
      transition: 'finalize_ready_pbc',
    })

    assertBlocked(result)
    expect(result.reason).toMatch(/stale|mismatch|pressure.*pass|based.*pressure/i)
  })
})

// ===========================================================================
// Invariant 6: finalize_after_patch_decision — old route=finalize must not reuse
// ===========================================================================

describe('finalize_after_patch_decision after patch revise (Invariant 6)', () => {
  test('BLOCKED: old patch_decision.route=finalize before revise boundary cannot finalize later draft', () => {
    // Round 1: finalize decision recorded, then superseded by a revise decision.
    // Round 2: new draft + pressure_pass exist but no NEW route=finalize after the boundary.
    const timeline: PbcEvidenceSnapshot[] = [
      draft('ev_draft_1'),
      pressurePass('ev_pp_1', { verdict: 'needs_patch', reviewedDraftEvidenceId: 'ev_draft_1' }),
      patchDecision('ev_pd_old_finalize', 'finalize'), // OLD finalize — pre-boundary
      patchDecision('ev_pd_revise', 'revise'), // revise boundary — supersedes old finalize
      draft('ev_draft_2'), // fresh draft after revise
      pressurePass('ev_pp_2', {
        verdict: 'needs_patch',
        reviewedDraftEvidenceId: 'ev_draft_2',
      }),
      // No new patch_decision.route=finalize after the revise boundary
    ]

    const result = checkPbcFreshness({
      evidenceTimeline: timeline,
      transition: 'finalize_after_patch_decision',
    })

    assertBlocked(result)
    expect(result.reason).toMatch(/stale|old.*patch|patch.*stale|revise.*boundary|no.*finalize/i)
  })

  test('OK: fresh patch_decision.route=finalize after revise boundary is valid', () => {
    const timeline: PbcEvidenceSnapshot[] = [
      draft('ev_draft_1'),
      pressurePass('ev_pp_1', { verdict: 'needs_patch', reviewedDraftEvidenceId: 'ev_draft_1' }),
      patchDecision('ev_pd_revise', 'revise'), // revise boundary
      draft('ev_draft_2'),
      pressurePass('ev_pp_2', {
        verdict: 'needs_patch',
        reviewedDraftEvidenceId: 'ev_draft_2',
      }),
      patchDecision('ev_pd_fresh_finalize', 'finalize'), // fresh finalize — POST-boundary ✓
    ]

    const result = checkPbcFreshness({
      evidenceTimeline: timeline,
      transition: 'finalize_after_patch_decision',
    })

    expect(result.blocked).toBe(false)
  })
})

// ===========================================================================
// Happy path — all fresh artifacts finalize normally (stays green in impl)
// ===========================================================================

describe('happy path (fresh artifacts, all refs match)', () => {
  test('full fresh path: draft → pressure(ready, reviewedDraftId=draft) → final(all refs match) → finalize_ready_pbc', () => {
    const timeline: PbcEvidenceSnapshot[] = [
      draft('ev_d1'),
      pressurePass('ev_pp1', { verdict: 'ready', reviewedDraftEvidenceId: 'ev_d1' }),
      pbcFinal('ev_f1', {
        basedOnDraftEvidenceId: 'ev_d1',
        basedOnPressurePassEvidenceId: 'ev_pp1',
      }),
    ]

    const result = checkPbcFreshness({
      evidenceTimeline: timeline,
      transition: 'finalize_ready_pbc',
    })

    expect(result.blocked).toBe(false)
  })

  test('happy path: run_pressure_pass before pbc_final (no refs to check yet)', () => {
    // Requesting run_pressure_pass on first cycle — just one draft, no prior revise
    const timeline: PbcEvidenceSnapshot[] = [draft('ev_d1')]

    const result = checkPbcFreshness({
      evidenceTimeline: timeline,
      transition: 'run_pressure_pass',
    })

    expect(result.blocked).toBe(false)
  })

  test('happy path: after too_vague revise, fresh draft + fresh pressure_pass(reviewedDraftId=new) passes', () => {
    const timeline: PbcEvidenceSnapshot[] = [
      draft('ev_d_old'),
      pressurePass('ev_pp_tooVague', { verdict: 'too_vague' }),
      draft('ev_d_new'), // fresh after boundary
      pressurePass('ev_pp_ready', {
        verdict: 'ready',
        reviewedDraftEvidenceId: 'ev_d_new', // matches the fresh draft ✓
      }),
      pbcFinal('ev_f1', {
        basedOnDraftEvidenceId: 'ev_d_new',
        basedOnPressurePassEvidenceId: 'ev_pp_ready',
      }),
    ]

    const result = checkPbcFreshness({
      evidenceTimeline: timeline,
      transition: 'finalize_ready_pbc',
    })

    expect(result.blocked).toBe(false)
  })

  test('happy path: patch revise cycle → fresh patch_decision(finalize) → finalize_after_patch_decision', () => {
    const timeline: PbcEvidenceSnapshot[] = [
      draft('ev_d1'),
      pressurePass('ev_pp1', { verdict: 'needs_patch', reviewedDraftEvidenceId: 'ev_d1' }),
      patchDecision('ev_pd_revise', 'revise'),
      draft('ev_d2'),
      pressurePass('ev_pp2', { verdict: 'needs_patch', reviewedDraftEvidenceId: 'ev_d2' }),
      patchDecision('ev_pd_finalize', 'finalize'), // fresh finalize after boundary ✓
      pbcFinal('ev_f1', {
        basedOnDraftEvidenceId: 'ev_d2',
        basedOnPressurePassEvidenceId: 'ev_pp2',
      }),
    ]

    const result = checkPbcFreshness({
      evidenceTimeline: timeline,
      transition: 'finalize_after_patch_decision',
    })

    expect(result.blocked).toBe(false)
  })
})

// ===========================================================================
// Guard does not block transitions it does not own
// ===========================================================================

describe('transitions not covered by freshness guard pass through', () => {
  test('normalize_feedback is never blocked by the freshness guard', () => {
    const result = checkPbcFreshness({ evidenceTimeline: [], transition: 'normalize_feedback' })
    expect(result.blocked).toBe(false)
  })

  test('draft_pbc is never blocked by the freshness guard', () => {
    const result = checkPbcFreshness({ evidenceTimeline: [], transition: 'draft_pbc' })
    expect(result.blocked).toBe(false)
  })

  test('revise_too_vague_pbc is never blocked by the freshness guard', () => {
    const result = checkPbcFreshness({ evidenceTimeline: [], transition: 'revise_too_vague_pbc' })
    expect(result.blocked).toBe(false)
  })
})
