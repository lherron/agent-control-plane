/**
 * RED TESTS — evidence-writer: skip no-match obligation-by-kind directive (T-03595)
 *
 * Module under test: src/wrkf/runtime/evidence-writer.ts
 *
 * Bug (lines 187-193 in resolveObligationId):
 *   When allowObligationKindLookup:true and no open obligation matches the
 *   directive's obligationKind, the function throws:
 *     'no open obligation matching kind "X" to satisfy'
 *
 *   Real agent output includes spurious satisfyObligations for evidence-only
 *   kinds (e.g. behavior_note, pre_interview_analysis) — kinds that are never
 *   registered as obligations, only as evidence. This causes the whole ingest to
 *   fail and roll back, losing the evidence that was just written.
 *
 * Fix required (resolveObligationId, by-kind branch):
 *   When allowObligationKindLookup:true AND no open obligation matches the kind
 *   → return a sentinel (null/undefined) so writeEvidenceAndSatisfyObligations
 *   can SKIP the directive rather than throw. Evidence writes (evidence.add)
 *   MUST still succeed even when the directive is skipped.
 *
 * Tests:
 *   1. by-kind directives (table): a no-match directive is skipped (no throw,
 *      evidence still written, obligation.satisfy NOT called), and a later
 *      matching directive is still satisfied with the matched id.
 *   2. explicit obligationId that does not exist → still throws. The
 *      leniency is BY-KIND only; explicit bad ids stay strict.
 */

import { describe, expect, test } from 'bun:test'

import {
  type EvidenceWritePolicy,
  type EvidenceWriterPort,
  writeEvidenceAndSatisfyObligations,
} from './evidence-writer.js'

// ---------------------------------------------------------------------------
// Helpers — raw record builders matching projections contract
// ---------------------------------------------------------------------------

function makeNextRaw(): Record<string, unknown> {
  return {
    instance: {
      state: { status: 'active', phase: 'collect_evidence' },
      revision: 1,
      contextHash: 'sha256:ctx0',
    },
    actions: [],
    blockedTransitions: [],
    openObligations: [],
    pendingEffects: [],
  }
}

// ---------------------------------------------------------------------------
// Fake port — spy + configurable obligation store
// ---------------------------------------------------------------------------

type SpyCall = { method: string; params: unknown }
type FakeObligation = { id: string; kind: string; status: string }

function makePort(opts: {
  obligations?: FakeObligation[]
}): EvidenceWriterPort & { _calls: SpyCall[] } {
  let evidenceSeq = 1
  const _calls: SpyCall[] = []
  const obligations = opts.obligations ?? []

  return {
    _calls,

    next: async (params) => {
      _calls.push({ method: 'next', params })
      return makeNextRaw()
    },

    evidence: {
      add: async (params) => {
        _calls.push({ method: 'evidence.add', params })
        const p = params as { kind: string }
        // projectEvidenceRecord requires id + kind at minimum
        return { id: `ev-${evidenceSeq++}`, kind: p.kind }
      },
    },

    obligation: {
      list: async (params) => {
        _calls.push({ method: 'obligation.list', params })
        // projectObligationRecord requires id, kind, status
        return obligations.map((o) => ({ id: o.id, kind: o.kind, status: o.status }))
      },

      satisfy: async (params) => {
        _calls.push({ method: 'obligation.satisfy', params })
        const p = params as { id: string }
        const obl = obligations.find((o) => o.id === p.id)
        if (obl === undefined) {
          throw new Error(`no obligation with id "${p.id}"`)
        }
        return { id: obl.id, kind: obl.kind, status: 'satisfied' }
      },
    },
  }
}

// ---------------------------------------------------------------------------
// By-kind directives: a no-match directive is skipped, a match is satisfied
// ---------------------------------------------------------------------------

describe('satisfyObligations by-kind: no matching open obligation → skip directive (T-03595)', () => {
  /**
   * The live bug: larry emits behavior_note evidence with a spurious
   * satisfyObligations:[{obligationKind:'behavior_note'}] directive. The kind
   * is evidence-only — no obligation of that kind is ever open — so the lookup
   * found nothing and threw, losing the ingest. A skipped directive must not
   * stop later by-kind directives that DO match an open obligation.
   */
  const cases: Array<{
    name: string
    obligations: FakeObligation[]
    evidence: Array<{ kind: string; summary: string }>
    satisfyObligations: Array<{ obligationKind: string; evidenceIndex: number }>
    satisfiedIds: string[]
  }> = [
    {
      name: 'by-kind satisfy directive with no open obligation of that kind is skipped and the evidence is still written',
      obligations: [],
      evidence: [{ kind: 'behavior_note', summary: 'agent followed policy constraints' }],
      satisfyObligations: [{ obligationKind: 'behavior_note', evidenceIndex: 0 }],
      satisfiedIds: [],
    },
    {
      name: 'two unmatched directives skip both obligations while writing both evidence items',
      obligations: [],
      evidence: [
        { kind: 'behavior_note', summary: 'first note' },
        { kind: 'pre_interview_analysis', summary: 'analysis text' },
      ],
      satisfyObligations: [
        { obligationKind: 'behavior_note', evidenceIndex: 0 },
        { obligationKind: 'pre_interview_analysis', evidenceIndex: 1 },
      ],
      satisfiedIds: [],
    },
    {
      name: 'a skipped no-match by-kind directive does not stop a later matching one from being satisfied',
      obligations: [
        { id: 'obl-clarification-001', kind: 'clarification_response', status: 'open' },
      ],
      evidence: [
        { kind: 'behavior_note', summary: 'first note' },
        { kind: 'clarification_response', summary: 'here is my clarification' },
      ],
      satisfyObligations: [
        { obligationKind: 'behavior_note', evidenceIndex: 0 },
        { obligationKind: 'clarification_response', evidenceIndex: 1 },
      ],
      satisfiedIds: ['obl-clarification-001'],
    },
  ]

  test.each(cases)('$name', async ({ obligations, evidence, satisfyObligations, satisfiedIds }) => {
    const port = makePort({ obligations })
    const policy: EvidenceWritePolicy = { allowObligationKindLookup: true }

    const result = await writeEvidenceAndSatisfyObligations(
      port,
      {
        task: 'task-behavior-note',
        role: 'larry',
        actor: 'larry',
        participantOutput: { evidence, satisfyObligations },
      },
      policy
    )

    // Every evidence item is written, in order
    const addCalls = port._calls.filter((c) => c.method === 'evidence.add')
    expect(addCalls.map((c) => (c.params as { kind: string }).kind)).toEqual(
      evidence.map((e) => e.kind)
    )
    expect(result.evidenceAdded.map((e) => e.kind)).toEqual(evidence.map((e) => e.kind))

    // Only matched obligations are satisfied, with the matched id
    const satisfyCalls = port._calls.filter((c) => c.method === 'obligation.satisfy')
    expect(satisfyCalls.map((c) => (c.params as { id: string }).id)).toEqual(satisfiedIds)
    expect(result.obligationsSatisfied.map((o) => o.id)).toEqual(satisfiedIds)
  })
})

// ---------------------------------------------------------------------------
// Test 3 — GREEN (strict): explicit obligationId that does not exist → throws
// ---------------------------------------------------------------------------

describe('satisfyObligations with explicit obligationId that does not exist (T-03595)', () => {
  /**
   * GREEN — already works; must stay strict after fix.
   *
   * The leniency introduced for the no-match BY-KIND case does NOT apply to
   * explicit obligationId references. A caller that names a specific id that
   * no longer exists (race, stale client) gets an error — this is intentional
   * to surface bad explicit ids rather than silently swallow them.
   */
  test('explicit obligationId that wrkf rejects is still sent to obligation.satisfy and the ingest fails', async () => {
    const port = makePort({
      obligations: [], // no obligations at all → satisfy will throw for any id
    })
    const policy: EvidenceWritePolicy = { allowObligationKindLookup: true }

    await expect(
      writeEvidenceAndSatisfyObligations(
        port,
        {
          task: 'task-bad-id',
          role: 'larry',
          actor: 'larry',
          participantOutput: {
            evidence: [{ kind: 'some_evidence', summary: 'something' }],
            satisfyObligations: [
              // explicit id that doesn't exist → must still throw
              { obligationId: 'nonexistent-obl-id', evidenceIndex: 0 },
            ],
          },
        },
        policy
      )
    ).rejects.toThrow()

    // Verify satisfy WAS attempted with the explicit id (not silently skipped)
    const satisfyCalls = port._calls.filter((c) => c.method === 'obligation.satisfy')
    expect(satisfyCalls).toHaveLength(1)
    const satisfyParams = satisfyCalls[0]!.params as { id: string }
    expect(satisfyParams.id).toBe('nonexistent-obl-id')
  })
})
