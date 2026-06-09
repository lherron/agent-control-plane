/**
 * Red tests for pbcWorkerPolicy (T-03414)
 *
 * Bug: worker-policy.ts:13 stops the worker whenever instance.stale===true.
 * Real wrkf marks stale:true on ~every active instance (fresh-read still shows
 * stale:true), so the worker no-ops every job (8/9 jobs stopped with
 * stop_reason=stale_instance, never launching an HRC agent).
 *
 * The worker already handles staleness correctly via fresh-read at turn start
 * + revision-keyed idempotency. The generic stale flag is NOT a reliable
 * "this job is obsolete" signal and must NOT short-circuit participant work.
 *
 * Tests marked [RED] currently FAIL — they assert the DESIRED behaviour after
 * the stale-stop guard is removed.  They will turn green once the fix is applied.
 *
 * Tests marked [GREEN] assert genuine stop conditions that must remain green
 * both before and after the fix.
 */

import { describe, expect, test } from 'bun:test'

import { pbcWorkerPolicy } from './worker-policy.js'
import type { NextActionResponse } from '../../projections.js'

// ---------------------------------------------------------------------------
// Helpers — build typed NextActionResponse objects directly
// ---------------------------------------------------------------------------

function makeNext(opts: {
  status: string
  phase: string
  stale?: boolean
  revision?: number
  actions?: Array<{ transition: string }>
}): NextActionResponse {
  return {
    instance: {
      state: { status: opts.status, phase: opts.phase },
      revision: opts.revision ?? 1,
      ...(opts.stale !== undefined ? { stale: opts.stale } : {}),
      raw: {},
    },
    actions: (opts.actions ?? []).map((a) => ({ transition: a.transition, raw: {} })),
    blockedTransitions: [],
    openObligations: [],
    pendingEffects: [],
    raw: {},
  }
}

function makePolicyInput(
  next: NextActionResponse,
  opts: {
    actor?: string
    reviewerActor?: string
    allowSimulation?: boolean
  } = {}
) {
  return {
    task: 'T-00001',
    next,
    actor: opts.actor ?? 'agent:pbc-writer',
    ...(opts.reviewerActor !== undefined ? { reviewerActor: opts.reviewerActor } : {}),
    ...(opts.allowSimulation !== undefined ? { allowSimulation: opts.allowSimulation } : {}),
  }
}

// ===========================================================================
// 1. Core red: stale:true on workable active instances MUST NOT stop
//
//    [RED] These currently FAIL because pbcWorkerPolicy returns
//    { kind: 'stop', reason: 'stale_instance' }.
//    After the fix (remove/scope the stale guard) they must pass.
// ===========================================================================

describe('pbcWorkerPolicy — stale flag must not stop workable active instances [RED]', () => {
  test('[RED] active/behavior_note with stale:true must not return stop/stale_instance', () => {
    const next = makeNext({
      status: 'active',
      phase: 'behavior_note',
      stale: true,
      actions: [{ transition: 'draft_pbc' }],
    })
    const result = pbcWorkerPolicy(makePolicyInput(next))

    // Currently returns { kind: 'stop', reason: 'stale_instance' } → FAILS
    // After fix must return { kind: 'continue' } → passes
    expect(result).not.toMatchObject({ kind: 'stop', reason: 'stale_instance' })
  })

  test('[RED] active/behavior_note with stale:true must return {kind:continue}', () => {
    const next = makeNext({
      status: 'active',
      phase: 'behavior_note',
      stale: true,
      actions: [{ transition: 'draft_pbc' }],
    })
    const result = pbcWorkerPolicy(makePolicyInput(next))

    // After fix the default return { kind: 'continue' } must be reached
    expect(result.kind).toBe('continue')
  })

  test('[RED] active/pbc_draft with stale:true must not return stop/stale_instance', () => {
    const next = makeNext({
      status: 'active',
      phase: 'pbc_draft',
      stale: true,
      actions: [{ transition: 'run_pressure_pass' }],
    })
    const result = pbcWorkerPolicy(makePolicyInput(next))

    expect(result).not.toMatchObject({ kind: 'stop', reason: 'stale_instance' })
  })

  test('[RED] active/pbc_draft with stale:true must return {kind:continue}', () => {
    const next = makeNext({
      status: 'active',
      phase: 'pbc_draft',
      stale: true,
      actions: [{ transition: 'run_pressure_pass' }],
    })
    const result = pbcWorkerPolicy(makePolicyInput(next))

    expect(result.kind).toBe('continue')
  })

  test('[RED] active/pressure with stale:true (distinct reviewer present) must not stop stale_instance', () => {
    // finalize_ready_pbc with a DISTINCT reviewer — SoD is satisfied,
    // so policy should continue, not stop for stale_instance
    const next = makeNext({
      status: 'active',
      phase: 'pressure',
      stale: true,
      actions: [{ transition: 'finalize_ready_pbc' }],
    })
    const result = pbcWorkerPolicy(
      makePolicyInput(next, {
        actor: 'agent:pbc-writer',
        reviewerActor: 'agent:pressure-reviewer',
      })
    )

    expect(result).not.toMatchObject({ kind: 'stop', reason: 'stale_instance' })
  })
})

// ===========================================================================
// 2. Genuine stop conditions MUST still stop [GREEN]
//
//    These must pass both before and after the stale-guard fix.
// ===========================================================================

describe('pbcWorkerPolicy — genuine stop conditions remain [GREEN]', () => {
  test('[GREEN] closed instance returns stop with reason closed', () => {
    const next = makeNext({ status: 'closed', phase: 'finalized', actions: [] })
    const result = pbcWorkerPolicy(makePolicyInput(next))
    expect(result).toEqual({ kind: 'stop', reason: 'closed' })
  })

  test('[GREEN] closed instance with stale:true still returns stop/closed (not stale_instance)', () => {
    // closed check happens BEFORE stale check; both before and after fix
    // the closed guard must fire first
    const next = makeNext({ status: 'closed', phase: 'finalized', stale: true, actions: [] })
    const result = pbcWorkerPolicy(makePolicyInput(next))
    expect(result).toEqual({ kind: 'stop', reason: 'closed' })
  })

  test('[GREEN] waiting/clarification without allowSimulation returns stop/requires_product_owner_clarification', () => {
    const next = makeNext({ status: 'waiting', phase: 'clarification', actions: [] })
    const result = pbcWorkerPolicy(makePolicyInput(next))
    expect(result).toMatchObject({ kind: 'stop', reason: 'requires_product_owner_clarification' })
  })

  test('[GREEN] waiting/clarification with stale:true still stops for clarification (not stale_instance)', () => {
    const next = makeNext({ status: 'waiting', phase: 'clarification', stale: true, actions: [] })
    const result = pbcWorkerPolicy(makePolicyInput(next))
    // After fix: closed runs first, clarification runs next — stale is ignored
    // Before fix: stale runs second and stops with stale_instance
    // This test is GREEN before AND after the fix only if closed/clarification
    // are checked BEFORE stale. Currently stale is checked before clarification
    // so this test is also RED before the fix.
    expect(result).not.toMatchObject({ kind: 'stop', reason: 'stale_instance' })
    expect(result).toMatchObject({ kind: 'stop', reason: 'requires_product_owner_clarification' })
  })

  test('[GREEN] finalization action without distinct reviewer (same actor) stops with requires_distinct_pressure_reviewer', () => {
    const next = makeNext({
      status: 'active',
      phase: 'pressure',
      actions: [{ transition: 'finalize_ready_pbc' }],
    })
    // reviewerActor === actor → SoD violation
    const result = pbcWorkerPolicy(
      makePolicyInput(next, { actor: 'agent:pbc-writer', reviewerActor: 'agent:pbc-writer' })
    )
    expect(result).toMatchObject({ kind: 'stop', reason: 'requires_distinct_pressure_reviewer' })
  })

  test('[GREEN] finalization action with no reviewerActor stops with requires_distinct_pressure_reviewer', () => {
    const next = makeNext({
      status: 'active',
      phase: 'pressure',
      actions: [{ transition: 'finalize_ready_pbc' }],
    })
    const result = pbcWorkerPolicy(
      makePolicyInput(next, { actor: 'agent:pbc-writer' })
    )
    expect(result).toMatchObject({ kind: 'stop', reason: 'requires_distinct_pressure_reviewer' })
  })
})
