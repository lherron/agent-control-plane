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
 *   1. [RED]   by-kind directive with no matching open obligation → directive
 *              skipped, no throw, evidence still written, obligation.satisfy
 *              NOT called. Currently THROWS.
 *   2. [GREEN] by-kind directive with a matching open obligation → satisfied as
 *              before. Already works; must stay green after the fix.
 *   3. [GREEN] explicit obligationId that does not exist → still throws. The
 *              leniency is BY-KIND only; explicit bad ids stay strict.
 */

import { describe, expect, test } from 'bun:test'

import {
  type EvidenceWriterPort,
  type EvidenceWritePolicy,
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
// Test 1 — RED: by-kind directive, NO matching open obligation → skip, no throw
// ---------------------------------------------------------------------------

describe('satisfyObligations by-kind: no matching open obligation → skip directive (T-03595)', () => {
  /**
   * RED — currently throws:
   *   Error: no open obligation matching kind "behavior_note" to satisfy
   *
   * After fix: evidence.add IS called, obligation.satisfy IS NOT called,
   * result.evidenceAdded has 1 entry, result.obligationsSatisfied is empty.
   *
   * This is the live bug: larry emits behavior_note evidence with a spurious
   * satisfyObligations:[{obligationKind:'behavior_note'}] directive. The kind
   * is evidence-only — no obligation of that kind is ever open — so the lookup
   * finds nothing and currently throws, losing the ingest.
   */
  test(
    'evidence is written and directive is skipped — no throw, no satisfy call [RED: currently throws]',
    async () => {
      const port = makePort({
        obligations: [], // no open obligation of any kind
      })
      const policy: EvidenceWritePolicy = { allowObligationKindLookup: true }

      const result = await writeEvidenceAndSatisfyObligations(
        port,
        {
          task: 'task-behavior-note',
          role: 'larry',
          actor: 'larry',
          participantOutput: {
            evidence: [{ kind: 'behavior_note', summary: 'agent followed policy constraints' }],
            satisfyObligations: [
              // spurious: behavior_note is evidence-only, never an obligation
              { obligationKind: 'behavior_note', evidenceIndex: 0 },
            ],
          },
        },
        policy
      )

      // Evidence MUST be written
      const addCalls = port._calls.filter((c) => c.method === 'evidence.add')
      expect(addCalls).toHaveLength(1)
      expect(result.evidenceAdded).toHaveLength(1)
      expect(result.evidenceAdded[0]!.kind).toBe('behavior_note')

      // Directive MUST be skipped — no satisfy call
      const satisfyCalls = port._calls.filter((c) => c.method === 'obligation.satisfy')
      expect(satisfyCalls).toHaveLength(0)
      expect(result.obligationsSatisfied).toHaveLength(0)
    }
  )

  /**
   * Variant: multiple evidence items, mixed directives — one by-kind with no
   * match (behavior_note → skip), ensuring the non-matching directive does not
   * block evidence writes for the OTHER evidence items either.
   */
  test(
    'multiple evidence items: no-match by-kind directive skipped, all evidence still written [RED: currently throws]',
    async () => {
      const port = makePort({
        obligations: [], // still no open obligations
      })
      const policy: EvidenceWritePolicy = { allowObligationKindLookup: true }

      const result = await writeEvidenceAndSatisfyObligations(
        port,
        {
          task: 'task-multi-evidence',
          role: 'larry',
          actor: 'larry',
          participantOutput: {
            evidence: [
              { kind: 'behavior_note', summary: 'first note' },
              { kind: 'pre_interview_analysis', summary: 'analysis text' },
            ],
            satisfyObligations: [
              { obligationKind: 'behavior_note', evidenceIndex: 0 },
              { obligationKind: 'pre_interview_analysis', evidenceIndex: 1 },
            ],
          },
        },
        policy
      )

      // Both evidence items MUST be written
      const addCalls = port._calls.filter((c) => c.method === 'evidence.add')
      expect(addCalls).toHaveLength(2)
      expect(result.evidenceAdded).toHaveLength(2)

      // Both directives MUST be skipped
      const satisfyCalls = port._calls.filter((c) => c.method === 'obligation.satisfy')
      expect(satisfyCalls).toHaveLength(0)
      expect(result.obligationsSatisfied).toHaveLength(0)
    }
  )
})

// ---------------------------------------------------------------------------
// Test 2 — GREEN: by-kind directive, matching open obligation → satisfied
// ---------------------------------------------------------------------------

describe('satisfyObligations by-kind: matching open obligation → satisfied (T-03595)', () => {
  /**
   * GREEN — already works with current code; must continue to work after fix.
   *
   * A human /input response carries a clarification_response evidence item and
   * a satisfyObligations directive by kind. An open clarification_response
   * obligation exists → it must be satisfied.
   */
  test(
    'open obligation found by kind is satisfied and evidence is written [GREEN: must stay green]',
    async () => {
      const port = makePort({
        obligations: [
          { id: 'obl-clarification-001', kind: 'clarification_response', status: 'open' },
        ],
      })
      const policy: EvidenceWritePolicy = { allowObligationKindLookup: true }

      const result = await writeEvidenceAndSatisfyObligations(
        port,
        {
          task: 'task-clarification',
          role: 'human',
          actor: 'user-1',
          participantOutput: {
            evidence: [
              {
                kind: 'clarification_response',
                summary: 'here is my clarification',
                facts: { clarification_needed: false },
              },
            ],
            satisfyObligations: [{ obligationKind: 'clarification_response', evidenceIndex: 0 }],
          },
        },
        policy
      )

      // Evidence written
      const addCalls = port._calls.filter((c) => c.method === 'evidence.add')
      expect(addCalls).toHaveLength(1)
      expect(result.evidenceAdded).toHaveLength(1)

      // Obligation satisfied with the matched id
      const satisfyCalls = port._calls.filter((c) => c.method === 'obligation.satisfy')
      expect(satisfyCalls).toHaveLength(1)
      const satisfyParams = satisfyCalls[0]!.params as { id: string; task: string }
      expect(satisfyParams.id).toBe('obl-clarification-001')
      expect(result.obligationsSatisfied).toHaveLength(1)
      expect(result.obligationsSatisfied[0]!.id).toBe('obl-clarification-001')
    }
  )
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
  test(
    'explicit bad obligationId propagates the error — strict path unchanged [GREEN: must stay green]',
    async () => {
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
    }
  )
})
