/**
 * Red tests for pbc-evidence.ts (Phase 3).
 *
 * Defines the contract for:
 *   validateParticipantOutputFacts(output: ParticipantOutput): void
 *   ingestEvidenceAndSatisfyObligations(port, input): Promise<EvidenceIngestionResult>
 *
 * All tests will fail until the module is implemented — that is by design.
 *
 * Contract summary (SPEC §4.9, §4.10):
 *   - Validate facts for known evidence kinds before sending to wrkf
 *   - Call evidence.add with actor, role, data forwarded from participant output
 *   - Re-read next AFTER every evidence.add batch and BEFORE any transition
 *   - Satisfy obligations: obligation.list → match by id or (kind + blocking) → obligation.satisfy
 *   - Agent role must NOT synthesize product_owner obligation evidence unless
 *     allowProductOwnerSimulation=true
 *
 * Fake WrkfPort uses a `_calls` spy to assert call ordering invariants.
 */

import { describe, expect, test } from 'bun:test'

// These imports define the module contract. They will fail until the module exists.
import {
  type EvidenceIngestionInput,
  type EvidenceIngestionResult,
  type ParticipantOutput,
  type PbcEvidencePort,
  ingestEvidenceAndSatisfyObligations,
  validateParticipantOutputFacts,
} from './pbc-evidence.js'

// ---------------------------------------------------------------------------
// Fake WrkfPort
// ---------------------------------------------------------------------------

type SpyCall = { method: string; params: unknown }

type FakePort = PbcEvidencePort & { _calls: SpyCall[] }

/** Minimal valid next response shape (raw — will be projected by the implementation) */
const MINIMAL_NEXT_RAW = {
  instance: {
    state: { status: 'active', phase: 'pressure' },
    revision: 3,
    contextHash: 'sha256:ctx3',
  },
  actions: [],
  blockedTransitions: [],
  openObligations: [],
  pendingEffects: [],
}

function makeFakePort(
  opts: {
    obligations?: Array<{ id: string; kind: string; status: string }>
    nextResponse?: unknown
  } = {}
): FakePort {
  const _calls: SpyCall[] = []
  const openObligations = opts.obligations ?? []
  const nextResp = opts.nextResponse ?? MINIMAL_NEXT_RAW
  let evidenceCounter = 0

  return {
    _calls,
    next: async (params: { task: string; role?: string }) => {
      _calls.push({ method: 'next', params })
      return nextResp
    },
    evidence: {
      add: async (params: {
        task: string
        kind: string
        ref?: string
        summary?: string
        facts?: Record<string, unknown>
        data?: unknown
        actor?: string
        role?: string
      }) => {
        _calls.push({ method: 'evidence.add', params })
        evidenceCounter++
        return { id: `ev_fake_${evidenceCounter}`, kind: params.kind, raw: {} }
      },
    },
    obligation: {
      list: async (params: { task: string }) => {
        _calls.push({ method: 'obligation.list', params })
        return openObligations
      },
      satisfy: async (params: { task: string; id: string; evidenceId?: string }) => {
        _calls.push({ method: 'obligation.satisfy', params })
        const matched = openObligations.find((o) => o.id === params.id) ?? {
          id: params.id,
          kind: 'unknown',
          status: 'open',
        }
        return { ...matched, status: 'satisfied', raw: {} }
      },
    },
  }
}

// ---------------------------------------------------------------------------
// Tests: validateParticipantOutputFacts
// ---------------------------------------------------------------------------

describe('validateParticipantOutputFacts', () => {
  // --- pre_interview_analysis -----------------------------------------------

  test('accepts pre_interview_analysis with clarification_needed=true (boolean)', () => {
    expect(() =>
      validateParticipantOutputFacts({
        evidence: [
          {
            kind: 'pre_interview_analysis',
            facts: { clarification_needed: true },
          },
        ],
      } satisfies ParticipantOutput)
    ).not.toThrow()
  })

  test('accepts pre_interview_analysis with clarification_needed=false (boolean)', () => {
    expect(() =>
      validateParticipantOutputFacts({
        evidence: [
          {
            kind: 'pre_interview_analysis',
            facts: { clarification_needed: false },
          },
        ],
      } satisfies ParticipantOutput)
    ).not.toThrow()
  })

  test('throws for non-boolean clarification_needed (string "true")', () => {
    expect(() =>
      validateParticipantOutputFacts({
        evidence: [
          {
            kind: 'pre_interview_analysis',
            facts: { clarification_needed: 'true' },
          },
        ],
      } satisfies ParticipantOutput)
    ).toThrow(/clarification_needed.*boolean/i)
  })

  test('throws for non-boolean clarification_needed (number 1)', () => {
    expect(() =>
      validateParticipantOutputFacts({
        evidence: [
          {
            kind: 'pre_interview_analysis',
            facts: { clarification_needed: 1 },
          },
        ],
      } satisfies ParticipantOutput)
    ).toThrow(/clarification_needed.*boolean/i)
  })

  // --- pressure_pass verdict ------------------------------------------------

  test('accepts pressure_pass with verdict="ready"', () => {
    expect(() =>
      validateParticipantOutputFacts({
        evidence: [{ kind: 'pressure_pass', facts: { verdict: 'ready' } }],
      } satisfies ParticipantOutput)
    ).not.toThrow()
  })

  test('accepts pressure_pass with verdict="needs_patch"', () => {
    expect(() =>
      validateParticipantOutputFacts({
        evidence: [{ kind: 'pressure_pass', facts: { verdict: 'needs_patch' } }],
      } satisfies ParticipantOutput)
    ).not.toThrow()
  })

  test('accepts pressure_pass with verdict="too_vague"', () => {
    expect(() =>
      validateParticipantOutputFacts({
        evidence: [{ kind: 'pressure_pass', facts: { verdict: 'too_vague' } }],
      } satisfies ParticipantOutput)
    ).not.toThrow()
  })

  test('throws for pressure_pass with invalid verdict', () => {
    expect(() =>
      validateParticipantOutputFacts({
        evidence: [{ kind: 'pressure_pass', facts: { verdict: 'approved' } }],
      } satisfies ParticipantOutput)
    ).toThrow(/verdict.*ready.*needs_patch.*too_vague|invalid.*verdict/i)
  })

  test('throws for pressure_pass missing verdict entirely', () => {
    expect(() =>
      validateParticipantOutputFacts({
        evidence: [{ kind: 'pressure_pass', facts: {} }],
      } satisfies ParticipantOutput)
    ).toThrow(/verdict/i)
  })

  // --- patch_decision route -------------------------------------------------

  test('accepts patch_decision with route="finalize"', () => {
    expect(() =>
      validateParticipantOutputFacts({
        evidence: [{ kind: 'patch_decision', facts: { route: 'finalize' } }],
      } satisfies ParticipantOutput)
    ).not.toThrow()
  })

  test('accepts patch_decision with route="revise"', () => {
    expect(() =>
      validateParticipantOutputFacts({
        evidence: [{ kind: 'patch_decision', facts: { route: 'revise' } }],
      } satisfies ParticipantOutput)
    ).not.toThrow()
  })

  test('throws for patch_decision with invalid route', () => {
    expect(() =>
      validateParticipantOutputFacts({
        evidence: [{ kind: 'patch_decision', facts: { route: 'skip' } }],
      } satisfies ParticipantOutput)
    ).toThrow(/route.*finalize.*revise|invalid.*route/i)
  })

  // --- disposition_decision resolution -------------------------------------

  test('accepts disposition_decision with resolution="wont_fix"', () => {
    expect(() =>
      validateParticipantOutputFacts({
        evidence: [{ kind: 'disposition_decision', facts: { resolution: 'wont_fix' } }],
      } satisfies ParticipantOutput)
    ).not.toThrow()
  })

  test('accepts disposition_decision with resolution="duplicate"', () => {
    expect(() =>
      validateParticipantOutputFacts({
        evidence: [{ kind: 'disposition_decision', facts: { resolution: 'duplicate' } }],
      } satisfies ParticipantOutput)
    ).not.toThrow()
  })

  test('accepts disposition_decision with resolution="unclear"', () => {
    expect(() =>
      validateParticipantOutputFacts({
        evidence: [{ kind: 'disposition_decision', facts: { resolution: 'unclear' } }],
      } satisfies ParticipantOutput)
    ).not.toThrow()
  })

  test('accepts disposition_decision with resolution="out_of_scope"', () => {
    expect(() =>
      validateParticipantOutputFacts({
        evidence: [{ kind: 'disposition_decision', facts: { resolution: 'out_of_scope' } }],
      } satisfies ParticipantOutput)
    ).not.toThrow()
  })

  test('throws for disposition_decision with invalid resolution', () => {
    expect(() =>
      validateParticipantOutputFacts({
        evidence: [{ kind: 'disposition_decision', facts: { resolution: 'rejected' } }],
      } satisfies ParticipantOutput)
    ).toThrow(/resolution.*wont_fix.*duplicate.*unclear.*out_of_scope|invalid.*resolution/i)
  })

  // --- general / optional facts ---------------------------------------------

  test('accepts evidence with no facts (facts are optional)', () => {
    expect(() =>
      validateParticipantOutputFacts({
        evidence: [{ kind: 'behavior_note', summary: 'Bug observed in prod' }],
      } satisfies ParticipantOutput)
    ).not.toThrow()
  })

  test('accepts empty evidence array', () => {
    expect(() =>
      validateParticipantOutputFacts({ evidence: [] } satisfies ParticipantOutput)
    ).not.toThrow()
  })

  test('validates all evidence items, not just the first', () => {
    expect(() =>
      validateParticipantOutputFacts({
        evidence: [
          { kind: 'behavior_note' },
          { kind: 'pressure_pass', facts: { verdict: 'INVALID' } }, // bad verdict
        ],
      } satisfies ParticipantOutput)
    ).toThrow(/verdict/i)
  })
})

// ---------------------------------------------------------------------------
// Tests: ingestEvidenceAndSatisfyObligations
// ---------------------------------------------------------------------------

describe('ingestEvidenceAndSatisfyObligations', () => {
  const TASK = 'T-02033'
  const ACTOR = 'agent:pbc-writer'
  const ROLE = 'agent' as const

  // --- evidence.add call shape ----------------------------------------------

  test('calls evidence.add with actor, role, and data from participant output', async () => {
    const port = makeFakePort()
    const input: EvidenceIngestionInput = {
      task: TASK,
      role: ROLE,
      actor: ACTOR,
      participantOutput: {
        evidence: [
          {
            kind: 'pressure_pass',
            summary: 'Pressure passed',
            facts: { verdict: 'ready' },
            data: { runRef: 'hrc:run-123' },
          },
        ],
      },
    }

    await ingestEvidenceAndSatisfyObligations(port, input)

    const addCall = port._calls.find((c) => c.method === 'evidence.add')
    expect(addCall).toBeDefined()
    const params = addCall!.params as Record<string, unknown>
    expect(params['task']).toBe(TASK)
    expect(params['kind']).toBe('pressure_pass')
    expect(params['actor']).toBe(ACTOR)
    expect(params['role']).toBe(ROLE)
    expect(params['data']).toEqual({ runRef: 'hrc:run-123' })
    expect(params['facts']).toEqual({ verdict: 'ready' })
  })

  test('returns added evidence records in result.evidenceAdded', async () => {
    const port = makeFakePort()
    const input: EvidenceIngestionInput = {
      task: TASK,
      role: ROLE,
      actor: ACTOR,
      participantOutput: {
        evidence: [{ kind: 'pbc_draft', summary: 'First draft' }],
      },
    }

    const result: EvidenceIngestionResult = await ingestEvidenceAndSatisfyObligations(port, input)

    expect(result.evidenceAdded).toHaveLength(1)
    expect(result.evidenceAdded[0]?.kind).toBe('pbc_draft')
  })

  test('calls evidence.add for every item in participantOutput.evidence', async () => {
    const port = makeFakePort()
    const input: EvidenceIngestionInput = {
      task: TASK,
      role: ROLE,
      actor: ACTOR,
      participantOutput: {
        evidence: [
          { kind: 'pressure_pass', facts: { verdict: 'ready' } },
          { kind: 'pbc_final', summary: 'Final PBC' },
        ],
      },
    }

    await ingestEvidenceAndSatisfyObligations(port, input)

    const addCalls = port._calls.filter((c) => c.method === 'evidence.add')
    expect(addCalls).toHaveLength(2)
    expect((addCalls[0]!.params as Record<string, unknown>)['kind']).toBe('pressure_pass')
    expect((addCalls[1]!.params as Record<string, unknown>)['kind']).toBe('pbc_final')
  })

  // --- next re-read invariant -----------------------------------------------

  test('re-reads next after all evidence adds (non-negotiable context-hash rotation invariant)', async () => {
    const port = makeFakePort()
    const input: EvidenceIngestionInput = {
      task: TASK,
      role: ROLE,
      actor: ACTOR,
      participantOutput: {
        evidence: [{ kind: 'pressure_pass', facts: { verdict: 'ready' } }],
      },
    }

    await ingestEvidenceAndSatisfyObligations(port, input)

    const callMethods = port._calls.map((c) => c.method)
    const lastEvidenceAddIdx = callMethods.lastIndexOf('evidence.add')
    expect(lastEvidenceAddIdx).toBeGreaterThan(-1)

    // A `next` call must appear after the last evidence.add
    const nextAfterEvidence = port._calls
      .slice(lastEvidenceAddIdx + 1)
      .some((c) => c.method === 'next')
    expect(nextAfterEvidence).toBe(true)
  })

  test('next is called using wrkf wire name (task, no actor)', async () => {
    const port = makeFakePort()
    const input: EvidenceIngestionInput = {
      task: TASK,
      role: ROLE,
      actor: ACTOR,
      participantOutput: {
        evidence: [{ kind: 'pbc_draft' }],
      },
    }

    await ingestEvidenceAndSatisfyObligations(port, input)

    const nextCall = port._calls.find((c) => c.method === 'next')
    expect(nextCall).toBeDefined()
    const params = nextCall!.params as Record<string, unknown>
    expect(params['task']).toBe(TASK)
    // actor must NOT be passed to next (spec §3.2: wrkf.next does not accept actor)
    expect(params['actor']).toBeUndefined()
  })

  // --- obligation satisfaction by id ----------------------------------------

  test('satisfies obligation by id when obligationId is supplied', async () => {
    const port = makeFakePort({
      obligations: [{ id: 'obl_clr_1', kind: 'clarification_response', status: 'open' }],
    })
    const input: EvidenceIngestionInput = {
      task: TASK,
      role: ROLE,
      actor: ACTOR,
      // PO-kind evidence produced by agent role requires the simulation flag (gate, SPEC §4.10)
      allowProductOwnerSimulation: true,
      participantOutput: {
        evidence: [{ kind: 'clarification_response', summary: 'Clarification provided' }],
        satisfyObligations: [{ obligationId: 'obl_clr_1', evidenceIndex: 0 }],
      },
    }

    const result = await ingestEvidenceAndSatisfyObligations(port, input)

    const satisfyCall = port._calls.find((c) => c.method === 'obligation.satisfy')
    expect(satisfyCall).toBeDefined()
    const params = satisfyCall!.params as Record<string, unknown>
    expect(params['task']).toBe(TASK)
    expect(params['id']).toBe('obl_clr_1')

    expect(result.obligationsSatisfied).toHaveLength(1)
    expect(result.obligationsSatisfied[0]?.kind).toBe('clarification_response')
  })

  test('calls obligation.list before obligation.satisfy', async () => {
    const port = makeFakePort({
      obligations: [{ id: 'obl_clr_1', kind: 'clarification_response', status: 'open' }],
    })
    const input: EvidenceIngestionInput = {
      task: TASK,
      role: ROLE,
      actor: ACTOR,
      // PO-kind evidence produced by agent role requires the simulation flag (gate, SPEC §4.10)
      allowProductOwnerSimulation: true,
      participantOutput: {
        evidence: [{ kind: 'clarification_response' }],
        satisfyObligations: [{ obligationId: 'obl_clr_1', evidenceIndex: 0 }],
      },
    }

    await ingestEvidenceAndSatisfyObligations(port, input)

    const callMethods = port._calls.map((c) => c.method)
    const listIdx = callMethods.indexOf('obligation.list')
    const satisfyIdx = callMethods.indexOf('obligation.satisfy')
    expect(listIdx).toBeGreaterThan(-1)
    expect(satisfyIdx).toBeGreaterThan(listIdx)
  })

  // --- obligation satisfaction by kind (no id) ------------------------------

  test('matches obligation by kind when obligationId is absent', async () => {
    const port = makeFakePort({
      obligations: [{ id: 'obl_pd_7', kind: 'patch_decision', status: 'open' }],
    })
    const input: EvidenceIngestionInput = {
      task: TASK,
      role: ROLE,
      actor: ACTOR,
      // PO-kind evidence produced by agent role requires the simulation flag (gate, SPEC §4.10)
      allowProductOwnerSimulation: true,
      participantOutput: {
        evidence: [{ kind: 'patch_decision', facts: { route: 'finalize' } }],
        satisfyObligations: [
          // No obligationId — must match by kind
          { obligationKind: 'patch_decision', evidenceIndex: 0 },
        ],
      },
    }

    await ingestEvidenceAndSatisfyObligations(port, input)

    const satisfyCall = port._calls.find((c) => c.method === 'obligation.satisfy')
    expect(satisfyCall).toBeDefined()
    const params = satisfyCall!.params as Record<string, unknown>
    // Must have resolved the obligation id from the list result
    expect(params['id']).toBe('obl_pd_7')
    expect(params['task']).toBe(TASK)
  })

  test('links evidenceId when calling obligation.satisfy', async () => {
    const port = makeFakePort({
      obligations: [{ id: 'obl_clr_1', kind: 'clarification_response', status: 'open' }],
    })
    const input: EvidenceIngestionInput = {
      task: TASK,
      role: ROLE,
      actor: ACTOR,
      // PO-kind evidence produced by agent role requires the simulation flag (gate, SPEC §4.10)
      allowProductOwnerSimulation: true,
      participantOutput: {
        evidence: [{ kind: 'clarification_response', summary: 'Here is the answer' }],
        satisfyObligations: [{ obligationId: 'obl_clr_1', evidenceIndex: 0 }],
      },
    }

    await ingestEvidenceAndSatisfyObligations(port, input)

    const satisfyCall = port._calls.find((c) => c.method === 'obligation.satisfy')
    const params = satisfyCall!.params as Record<string, unknown>
    // evidenceId must be the id returned by the evidence.add call
    expect(typeof params['evidenceId']).toBe('string')
    expect((params['evidenceId'] as string).length).toBeGreaterThan(0)
  })

  // --- full call-order invariant (evidence → list → satisfy → next) ---------

  test('call order invariant: evidence.add before obligation.list before obligation.satisfy before next', async () => {
    const port = makeFakePort({
      obligations: [{ id: 'obl_clr_1', kind: 'clarification_response', status: 'open' }],
    })
    const input: EvidenceIngestionInput = {
      task: TASK,
      role: ROLE,
      actor: ACTOR,
      // PO-kind evidence produced by agent role requires the simulation flag (gate, SPEC §4.10)
      allowProductOwnerSimulation: true,
      participantOutput: {
        evidence: [{ kind: 'clarification_response', summary: 'Clarification' }],
        satisfyObligations: [{ obligationId: 'obl_clr_1', evidenceIndex: 0 }],
      },
    }

    await ingestEvidenceAndSatisfyObligations(port, input)

    const callMethods = port._calls.map((c) => c.method)
    const evidenceAddIdx = callMethods.indexOf('evidence.add')
    const listIdx = callMethods.indexOf('obligation.list')
    const satisfyIdx = callMethods.indexOf('obligation.satisfy')
    // last next call (re-read after satisfaction, before any transition)
    const lastNextIdx = callMethods.lastIndexOf('next')

    expect(evidenceAddIdx).toBeGreaterThan(-1)
    expect(listIdx).toBeGreaterThan(evidenceAddIdx)
    expect(satisfyIdx).toBeGreaterThan(listIdx)
    expect(lastNextIdx).toBeGreaterThan(evidenceAddIdx)
  })

  // --- product_owner simulation gate ----------------------------------------

  test('rejects product_owner evidence for agent role without allowProductOwnerSimulation', async () => {
    const port = makeFakePort({
      obligations: [{ id: 'obl_clr_1', kind: 'clarification_response', status: 'open' }],
    })
    const input: EvidenceIngestionInput = {
      task: TASK,
      role: 'agent', // agent role must not synthesize PO evidence
      actor: ACTOR,
      participantOutput: {
        evidence: [
          // clarification_response is a product_owner obligation evidence kind
          { kind: 'clarification_response', summary: 'Fabricated answer' },
        ],
        satisfyObligations: [{ obligationId: 'obl_clr_1', evidenceIndex: 0 }],
      },
      // allowProductOwnerSimulation intentionally absent / false
    }

    await expect(ingestEvidenceAndSatisfyObligations(port, input)).rejects.toThrow(
      /product.?owner|fabricat|simulation/i
    )

    // evidence.add must NOT have been called
    const addCalls = port._calls.filter((c) => c.method === 'evidence.add')
    expect(addCalls).toHaveLength(0)
  })

  test('allows product_owner evidence for agent role when allowProductOwnerSimulation=true', async () => {
    const port = makeFakePort({
      obligations: [{ id: 'obl_clr_1', kind: 'clarification_response', status: 'open' }],
    })
    const input: EvidenceIngestionInput = {
      task: TASK,
      role: 'agent',
      actor: ACTOR,
      allowProductOwnerSimulation: true,
      participantOutput: {
        evidence: [{ kind: 'clarification_response', summary: 'Simulated answer' }],
        satisfyObligations: [{ obligationId: 'obl_clr_1', evidenceIndex: 0 }],
      },
    }

    const result = await ingestEvidenceAndSatisfyObligations(port, input)

    expect(result.evidenceAdded).toHaveLength(1)
    const addCalls = port._calls.filter((c) => c.method === 'evidence.add')
    expect(addCalls).toHaveLength(1)
  })

  test('does not gate evidence of non-product_owner kinds for agent role', async () => {
    const port = makeFakePort()
    const input: EvidenceIngestionInput = {
      task: TASK,
      role: 'agent',
      actor: ACTOR,
      participantOutput: {
        evidence: [
          { kind: 'pressure_pass', facts: { verdict: 'ready' } },
          { kind: 'pbc_final', summary: 'Final' },
        ],
      },
      // no allowProductOwnerSimulation — but these are agent-role evidence kinds
    }

    const result = await ingestEvidenceAndSatisfyObligations(port, input)

    expect(result.evidenceAdded).toHaveLength(2)
  })

  // --- result shape ---------------------------------------------------------

  test('returns the fresh next state in result.next after ingestion', async () => {
    const port = makeFakePort()
    const input: EvidenceIngestionInput = {
      task: TASK,
      role: ROLE,
      actor: ACTOR,
      participantOutput: {
        evidence: [{ kind: 'pbc_draft', summary: 'Draft' }],
      },
    }

    const result = await ingestEvidenceAndSatisfyObligations(port, input)

    // result.next must be the fresh state after all writes
    expect(result.next).toBeDefined()
    expect(result.next.instance.state.status).toBe('active')
    expect(result.next.instance.revision).toBe(3)
  })

  test('returns empty obligationsSatisfied when no satisfyObligations in output', async () => {
    const port = makeFakePort()
    const input: EvidenceIngestionInput = {
      task: TASK,
      role: ROLE,
      actor: ACTOR,
      participantOutput: {
        evidence: [{ kind: 'pbc_draft' }],
        // no satisfyObligations
      },
    }

    const result = await ingestEvidenceAndSatisfyObligations(port, input)

    expect(result.obligationsSatisfied).toEqual([])
    // obligation.list and satisfy must NOT have been called
    expect(port._calls.some((c) => c.method === 'obligation.satisfy')).toBe(false)
  })
})
