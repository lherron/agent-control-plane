/**
 * Red tests for participant-output.ts (Phase 4.5).
 *
 * Module under test: src/wrkf/participant-output.ts  (NOT YET IMPLEMENTED — all tests RED)
 *
 * ─── CONTRACT ─────────────────────────────────────────────────────────────────
 *
 * captureAndIngestParticipantOutput(
 *   port: ParticipantOutputPort,
 *   input: ParticipantOutputInput
 * ): Promise<CaptureIngestResult>
 *
 * makeParticipantOutputCaptureKey(routeKey: string, task: string): string
 *   → `${routeKey}:participant-output:${task}`
 *
 * ParticipantOutputInput:
 *   { task: string; role: string; actor: string; captureKey: string;
 *     mode: 'supplied' | 'launched-runtime';
 *     participantOutput?: ParticipantOutput;       // required when mode='supplied'
 *     allowProductOwnerSimulation?: boolean }
 *
 * CaptureIngestResult:
 *   { status: 'ingested' | 'already_captured' | 'awaiting_runtime_output';
 *     captureKey: string;
 *     evidenceAdded: EvidenceRecord[];
 *     obligationsSatisfied: ObligationRecord[];
 *     next?: NextActionResponse }
 *
 * ParticipantOutputPort:
 *   All PbcEvidencePort methods (next, evidence.add, obligation.list, obligation.satisfy)
 *   PLUS captures sub-namespace: { get, set }
 *   DOES NOT include transition.apply — this module MUST NOT apply transitions.
 *
 * ─── TWO MODES ────────────────────────────────────────────────────────────────
 *
 *   'supplied'          — caller provides participantOutput; module delegates to
 *                         pbc-evidence.ingestEvidenceAndSatisfyObligations (DO NOT
 *                         re-implement the ingest loop — reuse pbc-evidence.ts).
 *                         Records result in captures store for idempotency.
 *
 *   'launched-runtime'  — HRC run is in-progress; module returns 'awaiting_runtime_output'
 *                         status immediately. ZERO wrkf writes. NO capture recorded.
 *                         Caller (P5) must poll / wait for the runtime to deliver output
 *                         and then call again with mode='supplied'.
 *
 * ─── KEY INVARIANTS (each has at least one test) ──────────────────────────────
 *
 *   1. Supplied mode: evidence.add + obligation.satisfy called via ingest loop.
 *   2. Supplied mode: result.evidenceAdded / result.obligationsSatisfied populated.
 *   3. Supplied mode: result.next is the fresh NextActionResponse after ingestion.
 *   4. IDEMPOTENCY: second call with same captureKey → status='already_captured',
 *      evidence.add NOT called again, obligation.satisfy NOT called again.
 *   5. IDEMPOTENCY: captures.set is called after successful ingestion.
 *   6. IDEMPOTENCY: captures.get is checked first on every call.
 *   7. Launched-runtime mode: status='awaiting_runtime_output', zero wrkf writes.
 *   8. Launched-runtime mode: captures.set NOT called (nothing was ingested).
 *   9. No transition.apply EVER — port type excludes it; module contract prohibits it.
 *  10. Missing participantOutput when mode='supplied' throws synchronously / rejects.
 *  11. makeParticipantOutputCaptureKey key shape is deterministic and P6-reusable.
 *
 * ─── IDEMPOTENCY KEY SCHEME (for P6 routes) ───────────────────────────────────
 *
 *   Per SPEC §4.15, route-level idempotency keys follow the pattern:
 *     {routeKey}:participant-output:{task}
 *
 *   Where routeKey is the request-body hash or client-provided idempotency key
 *   from the HTTP header. Routes (P6) MUST compute the captureKey using
 *   makeParticipantOutputCaptureKey before calling captureAndIngestParticipantOutput.
 *
 *   The captures store keyed by this scheme allows ACP to return a deterministic
 *   response on replay without re-calling evidence.add (which wrkf does NOT dedup).
 */

import { describe, expect, test } from 'bun:test'

// These imports define the module contract.
// They will fail (red) until participant-output.ts is created.
import {
  captureAndIngestParticipantOutput,
  makeParticipantOutputCaptureKey,
  type CaptureIngestResult,
  type CaptureRecord,
  type ParticipantOutputPort,
  type ParticipantOutputInput,
} from './participant-output.js'

// Re-import ParticipantOutput from pbc-evidence (the module reuses that type — DO NOT redefine)
import type { ParticipantOutput } from './pbc-evidence.js'

// ---------------------------------------------------------------------------
// Fake port
// ---------------------------------------------------------------------------

type SpyCall = { method: string; params: unknown }

type FakePort = ParticipantOutputPort & {
  _calls: SpyCall[]
  _captureStore: Map<string, CaptureRecord>
}

/** Minimal valid next response (raw — projected by pbc-evidence internally) */
const MINIMAL_NEXT_RAW = {
  instance: {
    state: { status: 'active', phase: 'pbc_draft' },
    revision: 2,
    contextHash: 'sha256:ctx2',
  },
  actions: [{ id: 'run_pressure_pass', transition: 'run_pressure_pass', role: 'agent' }],
  blockedTransitions: [],
  openObligations: [],
  pendingEffects: [],
}

function makeFakePort(opts: {
  obligations?: Array<{ id: string; kind: string; status: string }>
  nextResponse?: unknown
  preSeedCaptures?: Map<string, CaptureRecord>
} = {}): FakePort {
  const _calls: SpyCall[] = []
  const openObligations = opts.obligations ?? []
  const nextResp = opts.nextResponse ?? MINIMAL_NEXT_RAW
  const _captureStore: Map<string, CaptureRecord> = opts.preSeedCaptures ?? new Map()
  let evidenceCounter = 0

  const port: FakePort = {
    _calls,
    _captureStore,

    // ── Wrkf evidence / obligation methods (satisfy PbcEvidencePort) ──────────

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

    // ── Captures store (idempotency) ──────────────────────────────────────────
    // NOTE: this sub-namespace is the only non-wrkf part of ParticipantOutputPort.
    // The module uses it to avoid duplicate evidence.add calls on replay.

    captures: {
      get: async (captureKey: string) => {
        _calls.push({ method: 'captures.get', params: { captureKey } })
        return _captureStore.get(captureKey)
      },
      set: async (captureKey: string, record: CaptureRecord) => {
        _calls.push({ method: 'captures.set', params: { captureKey, record } })
        _captureStore.set(captureKey, record)
      },
    },

    // ── INTENTIONAL OMISSION ─────────────────────────────────────────────────
    // transition.apply is NOT present on ParticipantOutputPort.
    // If the module ever attempted to call port.transition.apply it would throw
    // at runtime, making the violation impossible to miss.
  }

  return port
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const TASK = 'T-02035'
const ACTOR = 'agent:pbc-writer'
const ROLE = 'agent' as const
const ROUTE_KEY = 'req-abc123'

const SUPPLIED_PBC_DRAFT_OUTPUT: ParticipantOutput = {
  evidence: [{ kind: 'pbc_draft', summary: 'First draft of PBC' }],
}

const SUPPLIED_WITH_OBLIGATION: ParticipantOutput = {
  evidence: [{ kind: 'clarification_response', summary: 'Here is the clarification' }],
  satisfyObligations: [{ obligationId: 'obl_clr_1', evidenceIndex: 0 }],
}

// ===========================================================================
// makeParticipantOutputCaptureKey
// ===========================================================================

describe('makeParticipantOutputCaptureKey', () => {
  test('returns deterministic key with pattern {routeKey}:participant-output:{task}', () => {
    const key = makeParticipantOutputCaptureKey('req-abc123', 'T-02035')
    expect(key).toBe('req-abc123:participant-output:T-02035')
  })

  test('different routeKey → different key', () => {
    const k1 = makeParticipantOutputCaptureKey('req-aaa', 'T-02035')
    const k2 = makeParticipantOutputCaptureKey('req-bbb', 'T-02035')
    expect(k1).not.toBe(k2)
  })

  test('different task → different key', () => {
    const k1 = makeParticipantOutputCaptureKey('req-abc', 'T-00001')
    const k2 = makeParticipantOutputCaptureKey('req-abc', 'T-00002')
    expect(k1).not.toBe(k2)
  })

  test('same inputs always produce the same key (no randomness)', () => {
    const k1 = makeParticipantOutputCaptureKey('req-abc', 'T-02035')
    const k2 = makeParticipantOutputCaptureKey('req-abc', 'T-02035')
    expect(k1).toBe(k2)
  })

  test('key contains the task selector verbatim', () => {
    const key = makeParticipantOutputCaptureKey('any', 'T-12345')
    expect(key).toContain('T-12345')
  })

  test('key contains the routeKey verbatim', () => {
    const key = makeParticipantOutputCaptureKey('body-sha256:abc', 'T-02035')
    expect(key).toContain('body-sha256:abc')
  })
})

// ===========================================================================
// captureAndIngestParticipantOutput — SUPPLIED mode
// ===========================================================================

describe('captureAndIngestParticipantOutput — supplied mode', () => {
  // ── Basic shape ────────────────────────────────────────────────────────────

  test('returns status=ingested on first call', async () => {
    const port = makeFakePort()
    const input: ParticipantOutputInput = {
      task: TASK,
      role: ROLE,
      actor: ACTOR,
      captureKey: makeParticipantOutputCaptureKey(ROUTE_KEY, TASK),
      mode: 'supplied',
      participantOutput: SUPPLIED_PBC_DRAFT_OUTPUT,
    }

    const result: CaptureIngestResult = await captureAndIngestParticipantOutput(port, input)

    expect(result.status).toBe('ingested')
  })

  test('result.captureKey matches input.captureKey', async () => {
    const port = makeFakePort()
    const captureKey = makeParticipantOutputCaptureKey(ROUTE_KEY, TASK)
    const input: ParticipantOutputInput = {
      task: TASK,
      role: ROLE,
      actor: ACTOR,
      captureKey,
      mode: 'supplied',
      participantOutput: SUPPLIED_PBC_DRAFT_OUTPUT,
    }

    const result = await captureAndIngestParticipantOutput(port, input)

    expect(result.captureKey).toBe(captureKey)
  })

  test('result.evidenceAdded contains the ingested evidence records', async () => {
    const port = makeFakePort()
    const input: ParticipantOutputInput = {
      task: TASK,
      role: ROLE,
      actor: ACTOR,
      captureKey: makeParticipantOutputCaptureKey(ROUTE_KEY, TASK),
      mode: 'supplied',
      participantOutput: SUPPLIED_PBC_DRAFT_OUTPUT,
    }

    const result = await captureAndIngestParticipantOutput(port, input)

    expect(result.evidenceAdded).toHaveLength(1)
    expect(result.evidenceAdded[0]?.kind).toBe('pbc_draft')
  })

  test('result.next is the fresh NextActionResponse after ingestion', async () => {
    const port = makeFakePort()
    const input: ParticipantOutputInput = {
      task: TASK,
      role: ROLE,
      actor: ACTOR,
      captureKey: makeParticipantOutputCaptureKey(ROUTE_KEY, TASK),
      mode: 'supplied',
      participantOutput: SUPPLIED_PBC_DRAFT_OUTPUT,
    }

    const result = await captureAndIngestParticipantOutput(port, input)

    // next is populated from pbc-evidence ingest, which re-reads after writes
    expect(result.next).toBeDefined()
    expect(result.next?.instance.state.status).toBe('active')
    expect(result.next?.instance.revision).toBe(2)
  })

  test('result.obligationsSatisfied is empty when no obligations in output', async () => {
    const port = makeFakePort()
    const input: ParticipantOutputInput = {
      task: TASK,
      role: ROLE,
      actor: ACTOR,
      captureKey: makeParticipantOutputCaptureKey(ROUTE_KEY, TASK),
      mode: 'supplied',
      participantOutput: { evidence: [{ kind: 'pbc_draft' }] },
    }

    const result = await captureAndIngestParticipantOutput(port, input)

    expect(result.obligationsSatisfied).toEqual([])
  })

  // ── Delegates to pbc-evidence (evidence.add called) ────────────────────────

  test('calls evidence.add once per evidence item in participantOutput', async () => {
    const port = makeFakePort()
    const input: ParticipantOutputInput = {
      task: TASK,
      role: ROLE,
      actor: ACTOR,
      captureKey: makeParticipantOutputCaptureKey(ROUTE_KEY, TASK),
      mode: 'supplied',
      participantOutput: {
        evidence: [
          { kind: 'pressure_pass', facts: { verdict: 'ready' } },
          { kind: 'pbc_final', summary: 'Final PBC' },
        ],
      },
    }

    await captureAndIngestParticipantOutput(port, input)

    const addCalls = port._calls.filter((c) => c.method === 'evidence.add')
    expect(addCalls).toHaveLength(2)
    expect((addCalls[0]!.params as Record<string, unknown>)['kind']).toBe('pressure_pass')
    expect((addCalls[1]!.params as Record<string, unknown>)['kind']).toBe('pbc_final')
  })

  test('evidence.add is called with actor, role, and data forwarded', async () => {
    const port = makeFakePort()
    const input: ParticipantOutputInput = {
      task: TASK,
      role: ROLE,
      actor: ACTOR,
      captureKey: makeParticipantOutputCaptureKey(ROUTE_KEY, TASK),
      mode: 'supplied',
      participantOutput: {
        evidence: [
          {
            kind: 'pressure_pass',
            facts: { verdict: 'ready' },
            data: { runRef: 'hrc:run-xyz' },
          },
        ],
      },
    }

    await captureAndIngestParticipantOutput(port, input)

    const addCall = port._calls.find((c) => c.method === 'evidence.add')
    expect(addCall).toBeDefined()
    const params = addCall!.params as Record<string, unknown>
    expect(params['task']).toBe(TASK)
    expect(params['actor']).toBe(ACTOR)
    expect(params['role']).toBe(ROLE)
    expect(params['data']).toEqual({ runRef: 'hrc:run-xyz' })
  })

  test('satisfies obligations when satisfyObligations is present in participantOutput', async () => {
    const port = makeFakePort({
      obligations: [{ id: 'obl_clr_1', kind: 'clarification_response', status: 'open' }],
    })
    const input: ParticipantOutputInput = {
      task: TASK,
      role: ROLE,
      actor: ACTOR,
      captureKey: makeParticipantOutputCaptureKey(ROUTE_KEY, TASK),
      mode: 'supplied',
      allowProductOwnerSimulation: true, // required for PO evidence from agent role
      participantOutput: SUPPLIED_WITH_OBLIGATION,
    }

    const result = await captureAndIngestParticipantOutput(port, input)

    expect(result.obligationsSatisfied).toHaveLength(1)
    expect(result.obligationsSatisfied[0]?.kind).toBe('clarification_response')

    const satisfyCall = port._calls.find((c) => c.method === 'obligation.satisfy')
    expect(satisfyCall).toBeDefined()
    expect((satisfyCall!.params as Record<string, unknown>)['id']).toBe('obl_clr_1')
  })

  test('re-reads next after ingestion (context-hash rotation invariant delegated via pbc-evidence)', async () => {
    const port = makeFakePort()
    const input: ParticipantOutputInput = {
      task: TASK,
      role: ROLE,
      actor: ACTOR,
      captureKey: makeParticipantOutputCaptureKey(ROUTE_KEY, TASK),
      mode: 'supplied',
      participantOutput: SUPPLIED_PBC_DRAFT_OUTPUT,
    }

    await captureAndIngestParticipantOutput(port, input)

    const callMethods = port._calls.map((c) => c.method)
    const lastAddIdx = callMethods.lastIndexOf('evidence.add')
    expect(lastAddIdx).toBeGreaterThan(-1)

    // A 'next' call must appear after the last evidence.add
    const nextAfterEvidence = port._calls
      .slice(lastAddIdx + 1)
      .some((c) => c.method === 'next')
    expect(nextAfterEvidence).toBe(true)
  })

  // ── No transition.apply ────────────────────────────────────────────────────

  test('does NOT call transition.apply in supplied mode (transitions belong to P5)', async () => {
    const port = makeFakePort()
    const input: ParticipantOutputInput = {
      task: TASK,
      role: ROLE,
      actor: ACTOR,
      captureKey: makeParticipantOutputCaptureKey(ROUTE_KEY, TASK),
      mode: 'supplied',
      participantOutput: SUPPLIED_PBC_DRAFT_OUTPUT,
    }

    await captureAndIngestParticipantOutput(port, input)

    const transitionCalls = port._calls.filter((c) => c.method === 'transition.apply')
    expect(transitionCalls).toHaveLength(0)
  })

  // ── Error: missing participantOutput ───────────────────────────────────────

  test('rejects / throws when mode=supplied but participantOutput is missing', async () => {
    const port = makeFakePort()
    const input: ParticipantOutputInput = {
      task: TASK,
      role: ROLE,
      actor: ACTOR,
      captureKey: makeParticipantOutputCaptureKey(ROUTE_KEY, TASK),
      mode: 'supplied',
      // participantOutput intentionally absent
    }

    await expect(captureAndIngestParticipantOutput(port, input)).rejects.toThrow(
      /participantOutput.*required|supplied.*mode/i
    )
  })

  test('does NOT call evidence.add when participantOutput is missing', async () => {
    const port = makeFakePort()
    const input: ParticipantOutputInput = {
      task: TASK,
      role: ROLE,
      actor: ACTOR,
      captureKey: makeParticipantOutputCaptureKey(ROUTE_KEY, TASK),
      mode: 'supplied',
    }

    await expect(captureAndIngestParticipantOutput(port, input)).rejects.toThrow()

    const addCalls = port._calls.filter((c) => c.method === 'evidence.add')
    expect(addCalls).toHaveLength(0)
  })
})

// ===========================================================================
// captureAndIngestParticipantOutput — IDEMPOTENCY
// ===========================================================================

describe('captureAndIngestParticipantOutput — idempotency', () => {
  test('captures.get is called on every invocation before any wrkf write', async () => {
    const port = makeFakePort()
    const input: ParticipantOutputInput = {
      task: TASK,
      role: ROLE,
      actor: ACTOR,
      captureKey: makeParticipantOutputCaptureKey(ROUTE_KEY, TASK),
      mode: 'supplied',
      participantOutput: SUPPLIED_PBC_DRAFT_OUTPUT,
    }

    await captureAndIngestParticipantOutput(port, input)

    const callMethods = port._calls.map((c) => c.method)
    const getCaptureIdx = callMethods.indexOf('captures.get')
    const firstAddIdx = callMethods.indexOf('evidence.add')

    // captures.get must come before the first evidence.add
    expect(getCaptureIdx).toBeGreaterThan(-1)
    expect(firstAddIdx).toBeGreaterThan(-1)
    expect(getCaptureIdx).toBeLessThan(firstAddIdx)
  })

  test('captures.set is called after successful ingestion', async () => {
    const port = makeFakePort()
    const input: ParticipantOutputInput = {
      task: TASK,
      role: ROLE,
      actor: ACTOR,
      captureKey: makeParticipantOutputCaptureKey(ROUTE_KEY, TASK),
      mode: 'supplied',
      participantOutput: SUPPLIED_PBC_DRAFT_OUTPUT,
    }

    await captureAndIngestParticipantOutput(port, input)

    const setCaptureCall = port._calls.find((c) => c.method === 'captures.set')
    expect(setCaptureCall).toBeDefined()
    const params = setCaptureCall!.params as Record<string, unknown>
    expect(params['captureKey']).toBe(input.captureKey)
  })

  test('captures.set is called with the captureKey from input', async () => {
    const port = makeFakePort()
    const captureKey = makeParticipantOutputCaptureKey('req-xyz', TASK)
    const input: ParticipantOutputInput = {
      task: TASK,
      role: ROLE,
      actor: ACTOR,
      captureKey,
      mode: 'supplied',
      participantOutput: SUPPLIED_PBC_DRAFT_OUTPUT,
    }

    await captureAndIngestParticipantOutput(port, input)

    expect(port._captureStore.has(captureKey)).toBe(true)
  })

  test('second call with same captureKey returns status=already_captured', async () => {
    const port = makeFakePort()
    const captureKey = makeParticipantOutputCaptureKey(ROUTE_KEY, TASK)
    const input: ParticipantOutputInput = {
      task: TASK,
      role: ROLE,
      actor: ACTOR,
      captureKey,
      mode: 'supplied',
      participantOutput: SUPPLIED_PBC_DRAFT_OUTPUT,
    }

    // First call — fresh ingestion
    const firstResult = await captureAndIngestParticipantOutput(port, input)
    expect(firstResult.status).toBe('ingested')

    // Reset call log so we can cleanly inspect the second call's calls
    port._calls.length = 0

    // Second call — same captureKey
    const secondResult = await captureAndIngestParticipantOutput(port, input)
    expect(secondResult.status).toBe('already_captured')
  })

  test('second call with same captureKey does NOT call evidence.add again', async () => {
    const port = makeFakePort()
    const captureKey = makeParticipantOutputCaptureKey(ROUTE_KEY, TASK)
    const input: ParticipantOutputInput = {
      task: TASK,
      role: ROLE,
      actor: ACTOR,
      captureKey,
      mode: 'supplied',
      participantOutput: SUPPLIED_PBC_DRAFT_OUTPUT,
    }

    // First call
    await captureAndIngestParticipantOutput(port, input)

    // Clear calls from first invocation
    port._calls.length = 0

    // Second call
    await captureAndIngestParticipantOutput(port, input)

    const addCalls = port._calls.filter((c) => c.method === 'evidence.add')
    expect(addCalls).toHaveLength(0)
  })

  test('second call with same captureKey does NOT call obligation.satisfy again', async () => {
    const port = makeFakePort({
      obligations: [{ id: 'obl_clr_1', kind: 'clarification_response', status: 'open' }],
    })
    const captureKey = makeParticipantOutputCaptureKey(ROUTE_KEY, TASK)
    const input: ParticipantOutputInput = {
      task: TASK,
      role: ROLE,
      actor: ACTOR,
      captureKey,
      mode: 'supplied',
      allowProductOwnerSimulation: true,
      participantOutput: SUPPLIED_WITH_OBLIGATION,
    }

    // First call
    await captureAndIngestParticipantOutput(port, input)

    // Clear calls from first invocation
    port._calls.length = 0

    // Second call
    await captureAndIngestParticipantOutput(port, input)

    const satisfyCalls = port._calls.filter((c) => c.method === 'obligation.satisfy')
    expect(satisfyCalls).toHaveLength(0)
  })

  test('second call returns the evidence recorded during the first call', async () => {
    const port = makeFakePort()
    const captureKey = makeParticipantOutputCaptureKey(ROUTE_KEY, TASK)
    const input: ParticipantOutputInput = {
      task: TASK,
      role: ROLE,
      actor: ACTOR,
      captureKey,
      mode: 'supplied',
      participantOutput: SUPPLIED_PBC_DRAFT_OUTPUT,
    }

    // First call
    const firstResult = await captureAndIngestParticipantOutput(port, input)

    // Second call
    const secondResult = await captureAndIngestParticipantOutput(port, input)

    // evidenceAdded on the replay should match what was captured on the first call
    expect(secondResult.evidenceAdded).toHaveLength(firstResult.evidenceAdded.length)
    expect(secondResult.evidenceAdded[0]?.kind).toBe('pbc_draft')
  })

  test('different captureKeys are independent (different routes do not share idempotency)', async () => {
    const portA = makeFakePort()
    const portB = makeFakePort()

    const keyA = makeParticipantOutputCaptureKey('req-aaa', TASK)
    const keyB = makeParticipantOutputCaptureKey('req-bbb', TASK)

    const inputA: ParticipantOutputInput = {
      task: TASK,
      role: ROLE,
      actor: ACTOR,
      captureKey: keyA,
      mode: 'supplied',
      participantOutput: SUPPLIED_PBC_DRAFT_OUTPUT,
    }
    const inputB: ParticipantOutputInput = {
      task: TASK,
      role: ROLE,
      actor: ACTOR,
      captureKey: keyB,
      mode: 'supplied',
      participantOutput: SUPPLIED_PBC_DRAFT_OUTPUT,
    }

    // Each call on its own port should independently succeed as 'ingested'
    const resultA = await captureAndIngestParticipantOutput(portA, inputA)
    const resultB = await captureAndIngestParticipantOutput(portB, inputB)

    expect(resultA.status).toBe('ingested')
    expect(resultB.status).toBe('ingested')
  })

  test('pre-seeded captures store causes status=already_captured on first call', async () => {
    // Simulates ACP restart recovery: the route layer pre-loads known captures.
    const captureKey = makeParticipantOutputCaptureKey(ROUTE_KEY, TASK)
    const preSeedCaptures = new Map<string, CaptureRecord>([
      [
        captureKey,
        {
          status: 'ingested',
          evidenceAdded: [{ id: 'ev_existing_1', kind: 'pbc_draft', raw: {} }],
          obligationsSatisfied: [],
        },
      ],
    ])
    const port = makeFakePort({ preSeedCaptures })

    const input: ParticipantOutputInput = {
      task: TASK,
      role: ROLE,
      actor: ACTOR,
      captureKey,
      mode: 'supplied',
      participantOutput: SUPPLIED_PBC_DRAFT_OUTPUT,
    }

    const result = await captureAndIngestParticipantOutput(port, input)

    expect(result.status).toBe('already_captured')
    // No new evidence.add calls
    const addCalls = port._calls.filter((c) => c.method === 'evidence.add')
    expect(addCalls).toHaveLength(0)
  })
})

// ===========================================================================
// captureAndIngestParticipantOutput — LAUNCHED-RUNTIME mode
// ===========================================================================

describe('captureAndIngestParticipantOutput — launched-runtime mode', () => {
  test('returns status=awaiting_runtime_output', async () => {
    const port = makeFakePort()
    const input: ParticipantOutputInput = {
      task: TASK,
      role: ROLE,
      actor: ACTOR,
      captureKey: makeParticipantOutputCaptureKey(ROUTE_KEY, TASK),
      mode: 'launched-runtime',
      // no participantOutput — the runtime has not returned yet
    }

    const result: CaptureIngestResult = await captureAndIngestParticipantOutput(port, input)

    expect(result.status).toBe('awaiting_runtime_output')
  })

  test('result.evidenceAdded is empty in launched-runtime mode', async () => {
    const port = makeFakePort()
    const input: ParticipantOutputInput = {
      task: TASK,
      role: ROLE,
      actor: ACTOR,
      captureKey: makeParticipantOutputCaptureKey(ROUTE_KEY, TASK),
      mode: 'launched-runtime',
    }

    const result = await captureAndIngestParticipantOutput(port, input)

    expect(result.evidenceAdded).toEqual([])
  })

  test('result.obligationsSatisfied is empty in launched-runtime mode', async () => {
    const port = makeFakePort()
    const input: ParticipantOutputInput = {
      task: TASK,
      role: ROLE,
      actor: ACTOR,
      captureKey: makeParticipantOutputCaptureKey(ROUTE_KEY, TASK),
      mode: 'launched-runtime',
    }

    const result = await captureAndIngestParticipantOutput(port, input)

    expect(result.obligationsSatisfied).toEqual([])
  })

  test('result.next is undefined in launched-runtime mode (no wrkf reads)', async () => {
    const port = makeFakePort()
    const input: ParticipantOutputInput = {
      task: TASK,
      role: ROLE,
      actor: ACTOR,
      captureKey: makeParticipantOutputCaptureKey(ROUTE_KEY, TASK),
      mode: 'launched-runtime',
    }

    const result = await captureAndIngestParticipantOutput(port, input)

    expect(result.next).toBeUndefined()
  })

  test('does NOT call evidence.add in launched-runtime mode', async () => {
    const port = makeFakePort()
    const input: ParticipantOutputInput = {
      task: TASK,
      role: ROLE,
      actor: ACTOR,
      captureKey: makeParticipantOutputCaptureKey(ROUTE_KEY, TASK),
      mode: 'launched-runtime',
    }

    await captureAndIngestParticipantOutput(port, input)

    const addCalls = port._calls.filter((c) => c.method === 'evidence.add')
    expect(addCalls).toHaveLength(0)
  })

  test('does NOT call obligation.satisfy in launched-runtime mode', async () => {
    const port = makeFakePort()
    const input: ParticipantOutputInput = {
      task: TASK,
      role: ROLE,
      actor: ACTOR,
      captureKey: makeParticipantOutputCaptureKey(ROUTE_KEY, TASK),
      mode: 'launched-runtime',
    }

    await captureAndIngestParticipantOutput(port, input)

    const satisfyCalls = port._calls.filter((c) => c.method === 'obligation.satisfy')
    expect(satisfyCalls).toHaveLength(0)
  })

  test('does NOT call wrkf.next in launched-runtime mode', async () => {
    const port = makeFakePort()
    const input: ParticipantOutputInput = {
      task: TASK,
      role: ROLE,
      actor: ACTOR,
      captureKey: makeParticipantOutputCaptureKey(ROUTE_KEY, TASK),
      mode: 'launched-runtime',
    }

    await captureAndIngestParticipantOutput(port, input)

    const nextCalls = port._calls.filter((c) => c.method === 'next')
    expect(nextCalls).toHaveLength(0)
  })

  test('does NOT call transition.apply in launched-runtime mode', async () => {
    const port = makeFakePort()
    const input: ParticipantOutputInput = {
      task: TASK,
      role: ROLE,
      actor: ACTOR,
      captureKey: makeParticipantOutputCaptureKey(ROUTE_KEY, TASK),
      mode: 'launched-runtime',
    }

    await captureAndIngestParticipantOutput(port, input)

    const transitionCalls = port._calls.filter((c) => c.method === 'transition.apply')
    expect(transitionCalls).toHaveLength(0)
  })

  test('does NOT write to captures store in launched-runtime mode (nothing was ingested)', async () => {
    const port = makeFakePort()
    const captureKey = makeParticipantOutputCaptureKey(ROUTE_KEY, TASK)
    const input: ParticipantOutputInput = {
      task: TASK,
      role: ROLE,
      actor: ACTOR,
      captureKey,
      mode: 'launched-runtime',
    }

    await captureAndIngestParticipantOutput(port, input)

    expect(port._captureStore.has(captureKey)).toBe(false)

    const setCalls = port._calls.filter((c) => c.method === 'captures.set')
    expect(setCalls).toHaveLength(0)
  })

  test(
    'launched-runtime then supplied with same captureKey: supplied call succeeds (not blocked by prior awaiting status)',
    async () => {
      // Simulates the two-step lifecycle:
      // 1. Route receives request while HRC run is in-flight → mode=launched-runtime
      // 2. HRC runtime returns output → caller re-submits with mode=supplied + participantOutput
      const port = makeFakePort()
      const captureKey = makeParticipantOutputCaptureKey(ROUTE_KEY, TASK)

      // Step 1: launched-runtime — returns awaiting, nothing recorded
      const awaitingResult = await captureAndIngestParticipantOutput(port, {
        task: TASK,
        role: ROLE,
        actor: ACTOR,
        captureKey,
        mode: 'launched-runtime',
      })
      expect(awaitingResult.status).toBe('awaiting_runtime_output')
      expect(port._captureStore.has(captureKey)).toBe(false)

      // Step 2: supplied — ingests the actual output
      port._calls.length = 0
      const ingestedResult = await captureAndIngestParticipantOutput(port, {
        task: TASK,
        role: ROLE,
        actor: ACTOR,
        captureKey,
        mode: 'supplied',
        participantOutput: SUPPLIED_PBC_DRAFT_OUTPUT,
      })

      expect(ingestedResult.status).toBe('ingested')
      expect(ingestedResult.evidenceAdded).toHaveLength(1)
      expect(port._captureStore.has(captureKey)).toBe(true)
    }
  )
})

// ===========================================================================
// No transition.apply — module-level contract invariant
// ===========================================================================

describe('captureAndIngestParticipantOutput — no transition.apply ever', () => {
  // This is the paramount safety invariant: transitions belong to P5 autopilot.
  // Any call to transition.apply from within this module is a contract violation.

  test('ParticipantOutputPort type does NOT include a transition.apply method', () => {
    // Static assertion: if ParticipantOutputPort included transition.apply,
    // the fake port would have to implement it. The test verifies at runtime
    // that no call to 'transition.apply' exists in the port's _calls spy.
    //
    // The fake port in makeFakePort() intentionally has NO transition.apply property.
    // If the module tries to call (port as any).transition.apply(...) it would throw
    // TypeError at runtime — making the violation loud and testable.
    const port = makeFakePort()
    expect((port as Record<string, unknown>)['transition']).toBeUndefined()
  })

  test('no transition.apply call after supplied mode ingestion even with proposedTransition set', async () => {
    const port = makeFakePort()
    const input: ParticipantOutputInput = {
      task: TASK,
      role: ROLE,
      actor: ACTOR,
      captureKey: makeParticipantOutputCaptureKey(ROUTE_KEY, TASK),
      mode: 'supplied',
      participantOutput: {
        evidence: [{ kind: 'pressure_pass', facts: { verdict: 'ready' } }],
        // proposedTransition is a RECOMMENDATION to P5; this module must NOT act on it
        proposedTransition: 'finalize_ready_pbc',
      },
    }

    await captureAndIngestParticipantOutput(port, input)

    const transitionCalls = port._calls.filter((c) => c.method === 'transition.apply')
    expect(transitionCalls).toHaveLength(0)
  })

  test('no transition.apply on already_captured replay', async () => {
    const port = makeFakePort()
    const captureKey = makeParticipantOutputCaptureKey(ROUTE_KEY, TASK)
    const input: ParticipantOutputInput = {
      task: TASK,
      role: ROLE,
      actor: ACTOR,
      captureKey,
      mode: 'supplied',
      participantOutput: {
        evidence: [{ kind: 'pbc_draft' }],
        proposedTransition: 'run_pressure_pass',
      },
    }

    // First call
    await captureAndIngestParticipantOutput(port, input)
    port._calls.length = 0

    // Second call (replay)
    await captureAndIngestParticipantOutput(port, input)

    const transitionCalls = port._calls.filter((c) => c.method === 'transition.apply')
    expect(transitionCalls).toHaveLength(0)
  })
})

// ===========================================================================
// CaptureRecord shape stored in captures store
// ===========================================================================

describe('CaptureRecord stored in captures store', () => {
  test('stored record contains status=ingested', async () => {
    const port = makeFakePort()
    const captureKey = makeParticipantOutputCaptureKey(ROUTE_KEY, TASK)
    const input: ParticipantOutputInput = {
      task: TASK,
      role: ROLE,
      actor: ACTOR,
      captureKey,
      mode: 'supplied',
      participantOutput: SUPPLIED_PBC_DRAFT_OUTPUT,
    }

    await captureAndIngestParticipantOutput(port, input)

    const record = port._captureStore.get(captureKey)
    expect(record).toBeDefined()
    expect(record!.status).toBe('ingested')
  })

  test('stored record contains evidenceAdded', async () => {
    const port = makeFakePort()
    const captureKey = makeParticipantOutputCaptureKey(ROUTE_KEY, TASK)
    const input: ParticipantOutputInput = {
      task: TASK,
      role: ROLE,
      actor: ACTOR,
      captureKey,
      mode: 'supplied',
      participantOutput: SUPPLIED_PBC_DRAFT_OUTPUT,
    }

    await captureAndIngestParticipantOutput(port, input)

    const record = port._captureStore.get(captureKey)!
    expect(record.evidenceAdded).toHaveLength(1)
    expect(record.evidenceAdded[0]?.kind).toBe('pbc_draft')
  })

  test('stored record contains obligationsSatisfied', async () => {
    const port = makeFakePort({
      obligations: [{ id: 'obl_clr_1', kind: 'clarification_response', status: 'open' }],
    })
    const captureKey = makeParticipantOutputCaptureKey(ROUTE_KEY, TASK)
    const input: ParticipantOutputInput = {
      task: TASK,
      role: ROLE,
      actor: ACTOR,
      captureKey,
      mode: 'supplied',
      allowProductOwnerSimulation: true,
      participantOutput: SUPPLIED_WITH_OBLIGATION,
    }

    await captureAndIngestParticipantOutput(port, input)

    const record = port._captureStore.get(captureKey)!
    expect(record.obligationsSatisfied).toHaveLength(1)
    expect(record.obligationsSatisfied[0]?.kind).toBe('clarification_response')
  })
})
