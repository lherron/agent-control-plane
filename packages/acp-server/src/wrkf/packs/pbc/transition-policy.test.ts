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

describe('choosePbcTransition finalization role binding', () => {
  test("non-finalization transitions apply as the worker's own actor and role", async () => {
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
