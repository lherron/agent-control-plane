import { describe, expect, test } from 'bun:test'
import type { NextActionResponse } from '../../projections.js'
import { choosePbcTransition } from './transition-policy.js'

function makeNext(input: {
  status: string
  phase: string
  actions: { transition: string }[]
}): NextActionResponse {
  return {
    instance: {
      id: 'wfi_test',
      taskRef: 'wrkq:T-00001',
      template: { id: 'pbc-progressive-refinement', version: '8', hash: 'sha256:test' },
      state: { status: input.status, phase: input.phase },
      revision: 3,
      contextHash: 'sha256:ctx',
    },
    actions: input.actions.map((action) => ({ kind: 'transition', ...action })),
  } as unknown as NextActionResponse
}

const FRESH_TIMELINE = [
  { id: 'ev_draft_1', kind: 'pbc_draft', facts: { revision: 1 } },
  {
    id: 'ev_pp_1',
    kind: 'pressure_pass',
    facts: { verdict: 'ready' },
    data: { reviewedDraftEvidenceId: 'ev_draft_1' },
  },
  {
    id: 'ev_final_1',
    kind: 'pbc_final',
    data: { basedOnDraftEvidenceId: 'ev_draft_1', basedOnPressurePassEvidenceId: 'ev_pp_1' },
  },
]

describe('choosePbcTransition finalization role binding', () => {
  test('finalize_ready_pbc carries role pressure_reviewer with the reviewer actor', async () => {
    const chosen = await choosePbcTransition({
      next: makeNext({
        status: 'active',
        phase: 'pressure',
        actions: [{ transition: 'finalize_ready_pbc' }],
      }),
      actor: 'agent:pbc-writer',
      role: 'agent',
      reviewerActor: 'agent:pbc-reviewer',
      evidenceTimeline: FRESH_TIMELINE,
    })

    expect(chosen).toEqual({
      transition: 'finalize_ready_pbc',
      actor: 'agent:pbc-reviewer',
      role: 'pressure_reviewer',
    })
  })

  test('non-finalization transition carries no actor/role override', async () => {
    const chosen = await choosePbcTransition({
      next: makeNext({
        status: 'open',
        phase: 'intake',
        actions: [{ transition: 'normalize_feedback' }],
      }),
      actor: 'agent:pbc-writer',
      role: 'agent',
      reviewerActor: 'agent:pbc-reviewer',
      evidenceTimeline: [],
    })

    expect(chosen).toBe('normalize_feedback')
  })
})
