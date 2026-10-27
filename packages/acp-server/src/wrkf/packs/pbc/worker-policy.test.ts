/**
 * pbcWorkerPolicy stop conditions (T-03414).
 *
 * Stale-state branches and the no-reviewer finalization stop remain here.
 * Other stop conditions are covered through runPbcContinuationWorker.
 */

import { describe, expect, test } from 'bun:test'

import type { NextActionResponse } from '../../projections.js'
import { pbcWorkerPolicy } from './worker-policy.js'

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

describe('pbcWorkerPolicy — finalization requires a distinct pressure reviewer', () => {
  test('finalization with no pressure reviewer configured stops requires_distinct_pressure_reviewer', () => {
    const next = makeNext({
      status: 'active',
      phase: 'pressure',
      actions: [{ transition: 'finalize_ready_pbc' }],
    })
    const result = pbcWorkerPolicy(makePolicyInput(next, { actor: 'agent:pbc-writer' }))
    expect(result).toMatchObject({ kind: 'stop', reason: 'requires_distinct_pressure_reviewer' })
  })
})

describe('pbcWorkerPolicy stale-state branches', () => {
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

  test('[GREEN] closed instance with stale:true still returns stop/closed (not stale_instance)', () => {
    // closed check happens BEFORE stale check; both before and after fix
    // the closed guard must fire first
    const next = makeNext({ status: 'closed', phase: 'finalized', stale: true, actions: [] })
    const result = pbcWorkerPolicy(makePolicyInput(next))
    expect(result).toEqual({ kind: 'stop', reason: 'closed' })
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
})
