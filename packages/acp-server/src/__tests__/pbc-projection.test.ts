/**
 * RED UNIT TESTS — PbcTaskProjection artifacts + product actions (T-03110)
 *
 * Module under test: src/pbc/projection.ts → buildPbcTaskProjection()
 *
 * Two gaps in the current implementation that these tests lock in:
 *
 *   GAP 1 — artifacts: {} hardcoded
 *     buildPbcTaskProjection never reads evidence; artifacts is always the empty
 *     object regardless of what evidence was recorded on the task.
 *
 *   GAP 2 — actions are raw wrkf transition names, all enabled:true
 *     actions: next.actions.map(a => ({ kind: a.transition ?? ..., enabled: true }))
 *     The product contract requires exactly 5 product kinds with enablement driven
 *     by screen (derived from status+phase) and pending retryable effects.
 *
 * These tests call buildPbcTaskProjection() directly (no HTTP) and assert the
 * DESIRED shape.  They FAIL now and must go GREEN when the implementation
 * populates artifacts from evidence and derives product actions from screen.
 *
 * ARTIFACT KEY MAPPING  (wrkf kind → projection key):
 *   intake_metadata          → intake
 *   behavior_note            → behaviorNote
 *   pre_interview_analysis   → preInterviewAnalysis
 *   clarification_response   → clarificationResponse
 *   pbc_draft                → draft
 *   pressure_pass            → pressurePass
 *   patch_decision           → patchDecision
 *   pbc_final                → final
 *   disposition_decision     → disposition
 *
 * PRODUCT ACTION KINDS: continue | submit_clarification | submit_patch_decision
 *                       | dispose | retry_effect_delivery
 *
 * ENABLEMENT RULES:
 *   continue               → screen ∈ {working, starting}
 *   submit_clarification   → screen === clarification
 *   submit_patch_decision  → screen === patch_decision
 *   dispose                → screen ∉ {finalized, disposed}
 *   retry_effect_delivery  → pendingEffects has retryable:true
 *   ALL disabled           → screen ∈ {finalized, disposed}
 */

import { describe, expect, test } from 'bun:test'

import {
  buildPbcTaskProjection,
  type BuildPbcTaskProjectionInput,
} from '../pbc/projection.js'
import type { NextActionResponse } from '../wrkf/projections.js'

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a minimal NextActionResponse for unit tests.
 * The `raw` field is required by the type but content-irrelevant here.
 */
function makeNext(opts: {
  status: string
  phase: string
  revision?: number
  actions?: Array<{ id?: string; transition?: string; role?: string }>
  pendingEffects?: Array<{ id: string; kind: string; status: string; retryable?: boolean }>
  openObligations?: Array<{ id: string; kind: string; status: string }>
}): NextActionResponse {
  return {
    instance: {
      id: 'inst-unit-test',
      state: { status: opts.status, phase: opts.phase },
      revision: opts.revision ?? 0,
      raw: {},
    },
    actions: (opts.actions ?? []).map((a) => ({ ...a, raw: {} })),
    blockedTransitions: [],
    openObligations: (opts.openObligations ?? []).map((o) => ({ ...o, raw: {} })),
    pendingEffects: (opts.pendingEffects ?? []).map((e) => ({ ...e, raw: {} })),
    raw: {},
  }
}

/**
 * Minimal ArtifactView-shaped evidence record — exactly what the implementation
 * will receive after projecting raw wrkf evidence.list entries.
 */
type EvidenceSnap = {
  id: string
  kind: string
  data?: Record<string, unknown>
  facts?: Record<string, unknown>
  summary?: string
  raw?: Record<string, unknown>
}

/**
 * Call buildPbcTaskProjection with an evidence array even though the current
 * BuildPbcTaskProjectionInput type does not yet have that field.
 *
 * We cast via `unknown` to bypass TypeScript's excess-property check on object
 * literals.  The extra `evidence` field is preserved at runtime and is what the
 * implementation must read to populate artifacts.  Without the implementation,
 * artifacts remains {}.
 */
function buildWithEvidence(
  opts: Omit<BuildPbcTaskProjectionInput, 'next'> & {
    next: NextActionResponse
    evidence: EvidenceSnap[]
  }
): ReturnType<typeof buildPbcTaskProjection> {
  return buildPbcTaskProjection(opts as unknown as BuildPbcTaskProjectionInput)
}

// ─────────────────────────────────────────────────────────────────────────────
// §1 — artifacts populated from evidence (RED — projection.ts hardcodes {})
// ─────────────────────────────────────────────────────────────────────────────

describe('buildPbcTaskProjection — artifacts populated from evidence (RED, T-03110)', () => {
  test('[RED] intake_metadata evidence → artifacts.intake defined with first-class data', () => {
    const next = makeNext({ status: 'active', phase: 'behavior_note' })
    const evidence: EvidenceSnap[] = [
      { id: 'ev-001', kind: 'intake_metadata', data: { title: 'Fix login button' }, raw: {} },
    ]

    const projection = buildWithEvidence({ taskId: 'T-unit-01', next, evidence })

    // RED: artifacts is {} — intake will be undefined until impl populates it
    expect(projection.artifacts['intake']).toBeDefined()
    const intake = projection.artifacts['intake'] as Record<string, unknown>
    expect(intake['data']).toEqual({ title: 'Fix login button' })
  })

  test('[RED] behavior_note evidence → artifacts.behaviorNote defined', () => {
    const next = makeNext({ status: 'active', phase: 'behavior_note' })
    const evidence: EvidenceSnap[] = [
      { id: 'ev-001', kind: 'behavior_note', data: { notes: 'User double-taps save' }, raw: {} },
    ]

    const projection = buildWithEvidence({ taskId: 'T-unit-02', next, evidence })

    // RED: artifacts.behaviorNote must be defined
    expect(projection.artifacts['behaviorNote']).toBeDefined()
  })

  test('[RED] pbc_draft evidence → artifacts.draft defined with first-class data field', () => {
    const next = makeNext({ status: 'active', phase: 'behavior_note' })
    const evidence: EvidenceSnap[] = [
      { id: 'ev-001', kind: 'intake_metadata', data: { title: 'test' }, raw: {} },
      {
        id: 'ev-002',
        kind: 'pbc_draft',
        data: { content: 'Draft body text', sections: ['intro', 'scope'] },
        raw: {},
      },
    ]

    const projection = buildWithEvidence({ taskId: 'T-unit-03', next, evidence })

    // RED: artifacts.draft must be defined with data first-class
    expect(projection.artifacts['draft']).toBeDefined()
    const draft = projection.artifacts['draft'] as Record<string, unknown>
    expect(draft['data']).toBeDefined()
    expect((draft['data'] as Record<string, unknown>)['content']).toBe('Draft body text')
  })

  test('[RED] pbc_draft with summary → artifacts.draft carries summary as fallback', () => {
    const next = makeNext({ status: 'active', phase: 'behavior_note' })
    const evidence: EvidenceSnap[] = [
      {
        id: 'ev-001',
        kind: 'pbc_draft',
        summary: 'First draft of the PBC document',
        raw: {},
      },
    ]

    const projection = buildWithEvidence({ taskId: 'T-unit-04', next, evidence })

    // RED: artifacts.draft must be defined; summary is a fallback when no data
    expect(projection.artifacts['draft']).toBeDefined()
    const draft = projection.artifacts['draft'] as Record<string, unknown>
    expect(draft['summary']).toBe('First draft of the PBC document')
  })

  test('[RED] after revise loop, artifacts.draft shows latest fresh pbc_draft (not stale)', () => {
    // Evidence timeline: stale draft → too_vague pressure_pass (boundary) → fresh draft
    const next = makeNext({ status: 'active', phase: 'behavior_note', revision: 3 })
    const evidence: EvidenceSnap[] = [
      { id: 'ev-001', kind: 'intake_metadata', data: { title: 'test' }, raw: {} },
      { id: 'ev-002', kind: 'pbc_draft', data: { content: 'Stale draft v1', rev: 1 }, raw: {} },
      {
        id: 'ev-003',
        kind: 'pressure_pass',
        data: {},
        facts: { verdict: 'too_vague', reviewedDraftEvidenceId: 'ev-002' },
        raw: {},
      },
      // ↑ revision boundary — everything before this is stale
      { id: 'ev-004', kind: 'pbc_draft', data: { content: 'Fresh draft v2', rev: 2 }, raw: {} },
    ]

    const projection = buildWithEvidence({ taskId: 'T-unit-05', next, evidence })

    // RED: implementation must use currentRevisionWindow to find the fresh draft
    expect(projection.artifacts['draft']).toBeDefined()
    const draft = projection.artifacts['draft'] as Record<string, unknown>
    const draftData = draft['data'] as Record<string, unknown>
    // Must show ev-004 (fresh) NOT ev-002 (stale)
    expect(draftData['content']).toBe('Fresh draft v2')
    expect(draftData['rev']).toBe(2)
  })

  test('[RED] clarification_response evidence → artifacts.clarificationResponse defined', () => {
    const next = makeNext({ status: 'active', phase: 'behavior_note' })
    const evidence: EvidenceSnap[] = [
      {
        id: 'ev-001',
        kind: 'clarification_response',
        data: { answer: 'Double-click the save button' },
        raw: {},
      },
    ]

    const projection = buildWithEvidence({ taskId: 'T-unit-06', next, evidence })

    // RED: artifacts.clarificationResponse must be defined
    expect(projection.artifacts['clarificationResponse']).toBeDefined()
  })

  test('[RED] pressure_pass evidence → artifacts.pressurePass defined', () => {
    const next = makeNext({ status: 'active', phase: 'behavior_note' })
    const evidence: EvidenceSnap[] = [
      { id: 'ev-001', kind: 'pbc_draft', data: { content: 'draft' }, raw: {} },
      {
        id: 'ev-002',
        kind: 'pressure_pass',
        data: { review: 'Looks good' },
        facts: { verdict: 'ready', reviewedDraftEvidenceId: 'ev-001' },
        raw: {},
      },
    ]

    const projection = buildWithEvidence({ taskId: 'T-unit-07', next, evidence })

    // RED: artifacts.pressurePass must be defined
    expect(projection.artifacts['pressurePass']).toBeDefined()
  })

  test('[RED] patch_decision evidence → artifacts.patchDecision defined', () => {
    const next = makeNext({ status: 'active', phase: 'behavior_note' })
    const evidence: EvidenceSnap[] = [
      {
        id: 'ev-001',
        kind: 'patch_decision',
        data: { notes: 'One more revision needed' },
        facts: { route: 'revise' },
        raw: {},
      },
    ]

    const projection = buildWithEvidence({ taskId: 'T-unit-08', next, evidence })

    // RED: artifacts.patchDecision must be defined
    expect(projection.artifacts['patchDecision']).toBeDefined()
  })

  test('[RED] pbc_final evidence → artifacts.final defined', () => {
    const next = makeNext({ status: 'closed', phase: 'finalized' })
    const evidence: EvidenceSnap[] = [
      { id: 'ev-001', kind: 'pbc_final', data: { content: 'Final PBC document' }, raw: {} },
    ]

    const projection = buildWithEvidence({ taskId: 'T-unit-09', next, evidence })

    // RED: artifacts.final must be defined
    expect(projection.artifacts['final']).toBeDefined()
  })

  test('[RED] disposition_decision evidence → artifacts.disposition defined', () => {
    const next = makeNext({ status: 'closed', phase: 'disposed' })
    const evidence: EvidenceSnap[] = [
      {
        id: 'ev-001',
        kind: 'disposition_decision',
        data: { reason: 'Out of scope' },
        facts: { resolution: 'out_of_scope' },
        raw: {},
      },
    ]

    const projection = buildWithEvidence({ taskId: 'T-unit-10', next, evidence })

    // RED: artifacts.disposition must be defined
    expect(projection.artifacts['disposition']).toBeDefined()
  })

  test('[RED] artifacts empty when evidence list is empty', () => {
    const next = makeNext({ status: 'active', phase: 'behavior_note' })
    const projection = buildWithEvidence({ taskId: 'T-unit-11', next, evidence: [] })

    // This currently passes (artifacts is always {}) but pins the invariant
    expect(Object.keys(projection.artifacts)).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §2 — product actions shape and enablement (RED — projection maps raw names)
// ─────────────────────────────────────────────────────────────────────────────

describe('buildPbcTaskProjection — product actions shape and enablement (RED, T-03110)', () => {
  test('[RED] actions array always has exactly 5 product kinds', () => {
    // BEHAVIOR_NOTE_NEXT equivalent: active/behavior_note with raw action 'draft_pbc'
    const next = makeNext({
      status: 'active',
      phase: 'behavior_note',
      actions: [{ id: 'draft_pbc', transition: 'draft_pbc', role: 'agent' }],
    })
    const projection = buildPbcTaskProjection({ taskId: 'T-unit-20', next })

    const PRODUCT_KINDS = [
      'continue',
      'submit_clarification',
      'submit_patch_decision',
      'dispose',
      'retry_effect_delivery',
    ]

    // RED: currently actions is [{kind:'draft_pbc', enabled:true}] — wrong count + wrong kinds
    expect(projection.actions.length).toBe(5)
    for (const kind of PRODUCT_KINDS) {
      expect(projection.actions.map((a) => a.kind)).toContain(kind)
    }
  })

  test('[RED] actions contains no raw wrkf transition names', () => {
    const next = makeNext({
      status: 'active',
      phase: 'behavior_note',
      actions: [
        { id: 'draft_pbc', transition: 'draft_pbc', role: 'agent' },
        { id: 'normalize_feedback', transition: 'normalize_feedback', role: 'agent' },
      ],
    })
    const projection = buildPbcTaskProjection({ taskId: 'T-unit-21', next })

    // RED: raw wrkf names must NOT appear in actions (they belong in diagnostics.legalTransitions)
    expect(projection.actions.map((a) => a.kind)).not.toContain('draft_pbc')
    expect(projection.actions.map((a) => a.kind)).not.toContain('normalize_feedback')
  })

  test('[RED] working screen → continue enabled, submit_* disabled', () => {
    const next = makeNext({
      status: 'active',
      phase: 'behavior_note',
      actions: [{ id: 'draft_pbc', transition: 'draft_pbc' }],
    })
    const projection = buildPbcTaskProjection({ taskId: 'T-unit-22', next })
    const find = (kind: string) => projection.actions.find((a) => a.kind === kind)

    // RED: current output is [{kind:'draft_pbc', enabled:true}] — 'continue' not found
    expect(find('continue')?.enabled).toBe(true)
    expect(find('submit_clarification')?.enabled).toBe(false)
    expect(find('submit_patch_decision')?.enabled).toBe(false)
  })

  test('[RED] starting screen (active/intake) → continue enabled', () => {
    const next = makeNext({
      status: 'active',
      phase: 'intake',
      actions: [{ id: 'normalize_feedback', transition: 'normalize_feedback' }],
    })
    const projection = buildPbcTaskProjection({ taskId: 'T-unit-23', next })
    const find = (kind: string) => projection.actions.find((a) => a.kind === kind)

    // RED: 'continue' not in raw-mapped output
    expect(find('continue')?.enabled).toBe(true)
    expect(find('submit_clarification')?.enabled).toBe(false)
  })

  test('[RED] clarification screen (waiting/clarification) → submit_clarification enabled, continue disabled', () => {
    const next = makeNext({
      status: 'waiting',
      phase: 'clarification',
      openObligations: [{ id: 'obl-001', kind: 'clarification_response', status: 'open' }],
    })
    const projection = buildPbcTaskProjection({ taskId: 'T-unit-24', next })
    const find = (kind: string) => projection.actions.find((a) => a.kind === kind)

    // RED: current actions is [] (no actions for waiting state); submit_clarification not found
    expect(find('submit_clarification')?.enabled).toBe(true)
    expect(find('continue')?.enabled).toBe(false)
    expect(find('submit_patch_decision')?.enabled).toBe(false)
  })

  test('[RED] patch_decision screen (waiting/patch_decision) → submit_patch_decision enabled, continue disabled', () => {
    const next = makeNext({
      status: 'waiting',
      phase: 'patch_decision',
      openObligations: [{ id: 'obl-001', kind: 'patch_decision', status: 'open' }],
    })
    const projection = buildPbcTaskProjection({ taskId: 'T-unit-25', next })
    const find = (kind: string) => projection.actions.find((a) => a.kind === kind)

    // RED: current actions is []; submit_patch_decision not found
    expect(find('submit_patch_decision')?.enabled).toBe(true)
    expect(find('continue')?.enabled).toBe(false)
    expect(find('submit_clarification')?.enabled).toBe(false)
  })

  test('[RED] finalized screen (closed/finalized) → all product actions disabled', () => {
    const next = makeNext({ status: 'closed', phase: 'finalized' })
    const projection = buildPbcTaskProjection({ taskId: 'T-unit-26', next })

    // RED: current actions is [] (empty); must be 5 all-disabled product actions
    expect(projection.actions.length).toBeGreaterThan(0)
    for (const action of projection.actions) {
      expect(action.enabled).toBe(false)
    }
  })

  test('[RED] disposed screen (closed/disposed) → all product actions disabled', () => {
    const next = makeNext({ status: 'closed', phase: 'disposed' })
    const projection = buildPbcTaskProjection({ taskId: 'T-unit-27', next })

    // RED: current actions is []; must be 5 all-disabled product actions
    expect(projection.actions.length).toBeGreaterThan(0)
    for (const action of projection.actions) {
      expect(action.enabled).toBe(false)
    }
  })

  test('[RED] dispose action enabled on active/working screen', () => {
    const next = makeNext({
      status: 'active',
      phase: 'behavior_note',
      actions: [{ id: 'draft_pbc', transition: 'draft_pbc' }],
    })
    const projection = buildPbcTaskProjection({ taskId: 'T-unit-28', next })
    const disposeAction = projection.actions.find((a) => a.kind === 'dispose')

    // RED: 'dispose' not in raw-mapped [{kind:'draft_pbc',...}]
    expect(disposeAction).toBeDefined()
    expect(disposeAction?.enabled).toBe(true)
  })

  test('[RED] dispose action disabled on finalized screen', () => {
    const next = makeNext({ status: 'closed', phase: 'finalized' })
    const projection = buildPbcTaskProjection({ taskId: 'T-unit-29', next })
    const disposeAction = projection.actions.find((a) => a.kind === 'dispose')

    // RED: 'dispose' not present in raw-mapped [] for closed state
    expect(disposeAction).toBeDefined()
    expect(disposeAction?.enabled).toBe(false)
  })

  test('[RED] retry_effect_delivery enabled when pendingEffects has retryable:true', () => {
    const next = makeNext({
      status: 'active',
      phase: 'behavior_note',
      actions: [{ id: 'draft_pbc', transition: 'draft_pbc' }],
      pendingEffects: [{ id: 'eff-001', kind: 'set_task_state', status: 'failed', retryable: true }],
    })
    const projection = buildPbcTaskProjection({ taskId: 'T-unit-30', next })
    const retryAction = projection.actions.find((a) => a.kind === 'retry_effect_delivery')

    // RED: 'retry_effect_delivery' not in raw-mapped output
    expect(retryAction).toBeDefined()
    expect(retryAction?.enabled).toBe(true)
  })

  test('[RED] retry_effect_delivery disabled when no retryable pending effect', () => {
    // pending effect exists but NOT retryable
    const next = makeNext({
      status: 'active',
      phase: 'behavior_note',
      pendingEffects: [
        { id: 'eff-001', kind: 'set_task_state', status: 'pending', retryable: false },
      ],
    })
    const projection = buildPbcTaskProjection({ taskId: 'T-unit-31', next })
    const retryAction = projection.actions.find((a) => a.kind === 'retry_effect_delivery')

    // RED: 'retry_effect_delivery' not in raw output; after impl it must be present but disabled
    expect(retryAction).toBeDefined()
    expect(retryAction?.enabled).toBe(false)
  })

  test('[RED] retry_effect_delivery disabled when pendingEffects is empty', () => {
    const next = makeNext({ status: 'active', phase: 'behavior_note' })
    const projection = buildPbcTaskProjection({ taskId: 'T-unit-32', next })
    const retryAction = projection.actions.find((a) => a.kind === 'retry_effect_delivery')

    // RED: 'retry_effect_delivery' not present in raw-mapped output
    expect(retryAction).toBeDefined()
    expect(retryAction?.enabled).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §3 — diagnostics.legalTransitions invariant (GREEN — pins existing behavior)
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// §4 — intake artifact .data normalization from .facts (RED — T-03151)
//
// start.ts writes intake_metadata with `facts: intake` (no `data`).
// The T-03110 tests modeled intake with `data:` so they pass; the REAL shape
// is facts-only. buildArtifacts() must normalize: for intake_metadata, set
// data = data ?? facts so .data is always first-class.
// ─────────────────────────────────────────────────────────────────────────────

describe('buildPbcTaskProjection — intake artifact .data normalized from .facts (RED, T-03151)', () => {
  test('[RED] intake_metadata with facts-only (real start.ts shape) → artifacts.intake.data.rawFeedback populated', () => {
    // This is the REAL shape that start.ts produces:
    //   wrkf.evidence.add({ kind: 'intake_metadata', facts: intake })  — no `data`
    const next = makeNext({ status: 'active', phase: 'behavior_note' })
    const evidence: EvidenceSnap[] = [
      {
        id: 'ev-intake-real',
        kind: 'intake_metadata',
        // NOTE: facts only, NO data — mirrors the real start.ts write
        facts: { rawFeedback: 'Double-click save is broken', source: 'user' },
        raw: {},
      },
    ]

    const projection = buildWithEvidence({ taskId: 'T-unit-51', next, evidence })

    // RED: currently toArtifactView passes facts through but does NOT set data.
    // After the fix (data = data ?? facts for intake_metadata), data must equal facts.
    expect(projection.artifacts['intake']).toBeDefined()
    const intake = projection.artifacts['intake'] as Record<string, unknown>
    expect(intake['data']).toBeDefined()
    expect((intake['data'] as Record<string, unknown>)['rawFeedback']).toBe(
      'Double-click save is broken'
    )
    expect((intake['data'] as Record<string, unknown>)['source']).toBe('user')
  })

  test('[RED] intake_metadata with both facts and data → artifacts.intake.data uses data (not overwritten by facts)', () => {
    // Edge case: if both present, data wins (data ?? facts means data takes precedence)
    const next = makeNext({ status: 'active', phase: 'behavior_note' })
    const evidence: EvidenceSnap[] = [
      {
        id: 'ev-intake-both',
        kind: 'intake_metadata',
        data: { rawFeedback: 'From data field', source: 'explicit' },
        facts: { rawFeedback: 'From facts field', source: 'should-be-ignored' },
        raw: {},
      },
    ]

    const projection = buildWithEvidence({ taskId: 'T-unit-52', next, evidence })

    expect(projection.artifacts['intake']).toBeDefined()
    const intake = projection.artifacts['intake'] as Record<string, unknown>
    // data is present, so it should NOT be overwritten by facts
    expect((intake['data'] as Record<string, unknown>)['rawFeedback']).toBe('From data field')
    expect((intake['data'] as Record<string, unknown>)['source']).toBe('explicit')
  })

  test('[GREEN guard] non-intake kind (pbc_draft) with data → artifacts.draft.data still reads from .data', () => {
    // Guard: the facts→data normalization must ONLY apply to intake_metadata.
    // Other kinds that use `data` must continue to read from `.data` unchanged.
    const next = makeNext({ status: 'active', phase: 'behavior_note' })
    const evidence: EvidenceSnap[] = [
      {
        id: 'ev-draft-001',
        kind: 'pbc_draft',
        data: { content: 'Draft content here', sections: ['scope', 'criteria'] },
        raw: {},
      },
    ]

    const projection = buildWithEvidence({ taskId: 'T-unit-53', next, evidence })

    expect(projection.artifacts['draft']).toBeDefined()
    const draft = projection.artifacts['draft'] as Record<string, unknown>
    expect(draft['data']).toBeDefined()
    expect((draft['data'] as Record<string, unknown>)['content']).toBe('Draft content here')
  })

  test('any kind with facts only → facts promoted to .data (T-03658 supersedes the intake-only scope)', () => {
    // T-03151 scoped normalization to intake_metadata; T-03658 broadens it: for
    // ANY kind, data = data ?? facts so `.data` is uniformly populated.
    const next = makeNext({ status: 'active', phase: 'behavior_note' })
    const evidence: EvidenceSnap[] = [
      {
        id: 'ev-draft-facts',
        kind: 'pbc_draft',
        facts: { verdict: 'too_vague' },
        raw: {},
      },
    ]

    const projection = buildWithEvidence({ taskId: 'T-unit-54', next, evidence })

    expect(projection.artifacts['draft']).toBeDefined()
    const draft = projection.artifacts['draft'] as Record<string, unknown>
    expect((draft['data'] as Record<string, unknown>)['verdict']).toBe('too_vague')
    expect((draft['facts'] as Record<string, unknown>)['verdict']).toBe('too_vague')
  })
})

describe('buildPbcTaskProjection — human-form kinds .data normalized from .facts (RED, T-03658)', () => {
  test('[RED] disposition_decision with facts-only (real dispose handler shape) → artifacts.disposition.data populated', () => {
    const next = makeNext({ status: 'closed', phase: 'disposed' })
    const evidence: EvidenceSnap[] = [
      {
        id: 'ev-dispo-real',
        kind: 'disposition_decision',
        facts: { resolution: 'duplicate', reason: 'Covered by T-01234' },
        raw: {},
      },
    ]

    const projection = buildWithEvidence({ taskId: 'T-unit-58a', next, evidence })

    const dispo = projection.artifacts['disposition'] as Record<string, unknown>
    expect(dispo).toBeDefined()
    expect((dispo['data'] as Record<string, unknown>)['resolution']).toBe('duplicate')
    expect((dispo['data'] as Record<string, unknown>)['reason']).toBe('Covered by T-01234')
  })

  test('[RED] clarification_response + patch_decision with facts-only → .data populated', () => {
    const next = makeNext({ status: 'active', phase: 'pbc_draft' })
    const evidence: EvidenceSnap[] = [
      {
        id: 'ev-clarif-real',
        kind: 'clarification_response',
        facts: { answer: 'Only the lock screen preview leaks' },
        raw: {},
      },
      {
        id: 'ev-patch-real',
        kind: 'patch_decision',
        facts: { route: 'finalize' },
        raw: {},
      },
    ]

    const projection = buildWithEvidence({ taskId: 'T-unit-58b', next, evidence })

    const clarif = projection.artifacts['clarificationResponse'] as Record<string, unknown>
    expect((clarif['data'] as Record<string, unknown>)['answer']).toBe(
      'Only the lock screen preview leaks'
    )
    const patch = projection.artifacts['patchDecision'] as Record<string, unknown>
    expect((patch['data'] as Record<string, unknown>)['route']).toBe('finalize')
  })

  test('data precedence kept when both present (any kind)', () => {
    const next = makeNext({ status: 'active', phase: 'pbc_draft' })
    const evidence: EvidenceSnap[] = [
      {
        id: 'ev-clarif-both',
        kind: 'clarification_response',
        data: { answer: 'from data' },
        facts: { answer: 'from facts' },
        raw: {},
      },
    ]

    const projection = buildWithEvidence({ taskId: 'T-unit-58c', next, evidence })

    const clarif = projection.artifacts['clarificationResponse'] as Record<string, unknown>
    expect((clarif['data'] as Record<string, unknown>)['answer']).toBe('from data')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §3 — diagnostics.legalTransitions invariant (GREEN — pins existing behavior)
// ─────────────────────────────────────────────────────────────────────────────

describe('buildPbcTaskProjection — diagnostics.legalTransitions unchanged (GREEN guard)', () => {
  test('raw wrkf transition names remain in diagnostics.legalTransitions', () => {
    const next = makeNext({
      status: 'active',
      phase: 'behavior_note',
      actions: [
        { id: 'draft_pbc', transition: 'draft_pbc', role: 'agent' },
        { id: 'normalize_feedback', transition: 'normalize_feedback', role: 'agent' },
      ],
    })
    const projection = buildPbcTaskProjection({ taskId: 'T-unit-40', next })

    // This passes NOW and must continue to pass after the impl changes actions
    expect(projection.diagnostics.legalTransitions).toContain('draft_pbc')
    expect(projection.diagnostics.legalTransitions).toContain('normalize_feedback')
  })

  test('diagnostics.pack is always "pbc"', () => {
    const next = makeNext({ status: 'active', phase: 'intake' })
    const projection = buildPbcTaskProjection({ taskId: 'T-unit-41', next })
    expect(projection.diagnostics.pack).toBe('pbc')
  })
})
