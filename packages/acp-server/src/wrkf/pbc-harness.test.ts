/**
 * Red tests for pbc-harness.ts (Phase 5).
 *
 * Module under test: src/wrkf/pbc-harness.ts (NOT YET IMPLEMENTED — all tests RED)
 *
 * ─── CONTRACT ─────────────────────────────────────────────────────────────────
 *
 * Three operations returning PbcHarnessResult (SPEC §4.7):
 *
 *   runStep(port, input: RunStepRequest): Promise<PbcHarnessResult>
 *     - Starts a wrkf run (run.start)
 *     - launchRuntime=false (default): ingest evidence via captureAndIngestParticipantOutput → finish run
 *     - launchRuntime=true: no participantOutput yet → return 'launched' immediately
 *       (no transition, no run.finish until output captured later)
 *     - Apply transition ONLY if transitionPolicy='single-safe' selects exactly one
 *     - Deliver effects (deliverWrkfEffects) AFTER a committed transition
 *     - NEVER apply a transition before participant output is ingested
 *     - run.finish ONLY after evidence/obligation processing succeeds
 *
 * RunStepRequest shape (SPEC §4.6.2):
 *   { task: string; role?: string; actor: string; idempotencyKey: string;
 *     launchRuntime?: boolean; participantOutput?: ParticipantOutput;
 *     transitionPolicy?: 'none' | 'single-safe';
 *     scopeRef?: string; laneRef?: string }
 *
 * ApproveTransitionRequest shape (SPEC §4.6.3 + §4.12 idempotency key scheme):
 *   { task: string; transition: string; role?: string; actor: string;
 *     routeKey: string; runChecks?: boolean }
 *
 * RunUntilBlockedRequest shape (SPEC §4.6.4):
 *   { task: string; actor: string; pressureActor?: string;
 *     productOwnerActor?: string; idempotencyKey: string;
 *     maxTurns?: number; allowDisposition?: boolean;
 *     allowProductOwnerSimulation?: boolean }
 *
 * PbcHarnessResult shape (SPEC §4.7 — MUST include latest revision+contextHash after any write):
 *   { task: string; workflowRef: 'pbc-progressive-refinement@9';
 *     instance: { status: string; phase: string; revision: number; contextHash: string; stale?: boolean };
 *     next: { actions: unknown[]; blockedTransitions: unknown[]; openObligations: unknown[]; pendingEffects: unknown[] };
 *     runs: { started?: unknown; boundExternal?: unknown; finished?: unknown; failed?: unknown };
 *     evidenceAdded: unknown[]; obligationsSatisfied: unknown[];
 *     transitionApplied?: unknown; effectsDelivered: unknown[];
 *     stopReason?: string; diagnostics: string[] }
 *
 *   approveTransition(port, input: ApproveTransitionRequest): Promise<PbcHarnessResult>
 *     - Re-read next immediately before apply (fresh CAS)
 *     - Apply with fresh expectRevision + contextHash from that re-read
 *     - Idempotency key: `{routeKey}:transition:{transition}:{revision}`
 *     - runChecks per request; default false
 *     - Deliver effects after committed transition
 *     - Return PbcHarnessResult with latest revision+contextHash
 *
 *   runUntilBlocked(port, input: RunUntilBlockedRequest): Promise<PbcHarnessResult>
 *     - Autopilot per SPEC §4.17 + state-policy table §4.13
 *     - Stop reasons: closed, requires_product_owner_clarification,
 *       requires_product_owner_patch_decision, blocked_or_ambiguous,
 *       requires_distinct_pressure_reviewer, max_turns
 *     - Disposition transitions require allowDisposition=true
 *     - SoD: pressure_pass actor MUST differ from pbc_draft actor for finalization
 *     - Re-read next after every evidence/obligation write
 *
 * All tests are RED (import-only; module doesn't exist yet).
 *
 * ─── FAKE PORT PATTERN ────────────────────────────────────────────────────────
 * Uses a `_calls` spy (same pattern as pbc-evidence.test.ts / participant-output.test.ts).
 * Fake port is structural to PbcHarnessPort, not tied to @wrkq/client.
 */

import { describe, expect, test } from 'bun:test'

import { withWiredServer } from '../../test/fixtures/wired-server.js'
import type {
  ApproveTransitionRequest,
  PbcHarnessPort,
  PbcHarnessResult,
  RunStepRequest,
  RunUntilBlockedRequest,
} from './pbc-harness.js'
import type { AcpWrkfWorkflowPort } from './port.js'

// ---------------------------------------------------------------------------
// Fake WrkfPort
// ---------------------------------------------------------------------------

type SpyCall = { method: string; params: unknown }

type FakePbcHarnessPort = PbcHarnessPort & { _calls: SpyCall[] }

/** Minimal next response for a given state/phase/revision. */
function makeNextRaw(
  opts: {
    status?: string
    phase?: string
    revision?: number
    contextHash?: string
    stale?: boolean
    actions?: Array<{ transition: string; role?: string }>
    openObligations?: Array<{ id: string; kind: string; status: string }>
    pendingEffects?: Array<{ id: string; kind: string; status: string }>
  } = {}
): Record<string, unknown> {
  return {
    instance: {
      state: { status: opts.status ?? 'open', phase: opts.phase ?? 'intake' },
      revision: opts.revision ?? 0,
      contextHash: opts.contextHash ?? 'sha256:ctx0',
      ...(opts.stale !== undefined ? { stale: opts.stale } : {}),
    },
    actions: (opts.actions ?? []).map((a) => ({
      id: a.transition,
      transition: a.transition,
      ...(a.role !== undefined ? { role: a.role } : {}),
    })),
    blockedTransitions: [],
    openObligations: opts.openObligations ?? [],
    pendingEffects: opts.pendingEffects ?? [],
  }
}

function makeRunRecord(id: string): Record<string, unknown> {
  return { id, status: 'active' }
}

function makeEvidenceSnapshot(
  id: string,
  kind: string,
  opts: { facts?: Record<string, unknown>; data?: Record<string, unknown> } = {}
): Record<string, unknown> {
  return {
    id,
    kind,
    ...(opts.facts !== undefined ? { facts: opts.facts } : {}),
    ...(opts.data !== undefined ? { data: opts.data } : {}),
    raw: {},
  }
}

function makeObligationRecord(id: string, kind: string, status: string): Record<string, unknown> {
  return { id, kind, status, raw: {} }
}

function makeEffectRecord(id: string, kind: string, status: string): Record<string, unknown> {
  return { id, kind, status, raw: {} }
}

function makeTransitionResult(transition: string, revision: number): Record<string, unknown> {
  return { transition, revision, status: 'applied', raw: {} }
}

/**
 * Build a fake PbcHarnessPort with `_calls` spy.
 *
 * opts.nextSequence: successive next() calls return these in order. Repeats last.
 * opts.effects: effects returned by effect.list (pending by default)
 * opts.obligations: open obligations returned by obligation.list
 * opts.captureStore: pre-populated capture records (for idempotency tests)
 */
function makeFakePort(
  opts: {
    nextSequence?: Array<Record<string, unknown>>
    effects?: Array<{ id: string; kind: string; status: string }>
    obligations?: Array<{ id: string; kind: string; status: string }>
    captureStore?: Record<string, unknown>
    transitionShouldThrow?: (transition: string) => Error | undefined
    evidenceCounter?: { current: number }
    evidence?: Array<Record<string, unknown>>
  } = {}
): FakePbcHarnessPort {
  const _calls: SpyCall[] = []
  const nextSeq = opts.nextSequence ?? [makeNextRaw()]
  let nextCallIdx = 0
  const pendingEffects = opts.effects ?? []
  const openObligations = opts.obligations ?? []
  const captureStore: Record<string, unknown> = opts.captureStore ?? {}
  const evidenceTimeline: Record<string, unknown>[] = [...(opts.evidence ?? [])]
  let runCounter = 0
  let evidenceCounter = 0
  const transitionThrow = opts.transitionShouldThrow ?? (() => undefined)

  return {
    _calls,

    next: async (params: { task: string; role?: string }) => {
      _calls.push({ method: 'next', params })
      const response = nextSeq[Math.min(nextCallIdx, nextSeq.length - 1)]
      nextCallIdx++
      return response
    },

    evidence: {
      list: async (params: { task: string }) => {
        _calls.push({ method: 'evidence.list', params })
        return evidenceTimeline
      },
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
        const record = makeEvidenceSnapshot(`ev_fake_${evidenceCounter}`, params.kind, {
          ...(params.facts !== undefined ? { facts: params.facts } : {}),
          ...(typeof params.data === 'object' && params.data !== null
            ? { data: params.data as Record<string, unknown> }
            : {}),
        })
        evidenceTimeline.push(record)
        return record
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
        return makeObligationRecord(matched.id, matched.kind, 'satisfied')
      },
    },

    run: {
      start: async (params: {
        task: string
        role: string
        actor?: unknown
        idempotencyKey?: string
        lane?: string
        deliveryRef?: string
      }) => {
        _calls.push({ method: 'run.start', params })
        runCounter++
        return makeRunRecord(`run_fake_${runCounter}`)
      },

      finish: async (params: { runId: string; status?: string; summary?: string }) => {
        _calls.push({ method: 'run.finish', params })
        return makeRunRecord(params.runId)
      },

      fail: async (params: { runId: string; summary?: string }) => {
        _calls.push({ method: 'run.fail', params })
        return makeRunRecord(params.runId)
      },

      bindExternal: async (params: Record<string, unknown>) => {
        _calls.push({ method: 'run.bindExternal', params })
        return makeRunRecord(String(params['runId'] ?? 'run_ext'))
      },
    },

    transition: {
      apply: async (params: {
        task: string
        transition: string
        role?: string
        actor?: unknown
        expectRevision?: number
        contextHash?: string
        idempotencyKey?: string
        runChecks?: boolean
        dryRun?: boolean
      }) => {
        _calls.push({ method: 'transition.apply', params })
        const err = transitionThrow(params.transition)
        if (err !== undefined) {
          throw err
        }
        return makeTransitionResult(params.transition, (params.expectRevision ?? 0) + 1)
      },
    },

    effect: {
      list: async (params: { task: string }) => {
        _calls.push({ method: 'effect.list', params })
        return pendingEffects
      },
      deliver: async (params: { effectId: string; adapter: string }) => {
        _calls.push({ method: 'effect.deliver', params })
        return makeEffectRecord(params.effectId, 'set_task_state', 'delivered')
      },
    },

    captures: {
      get: async (captureKey: string) => {
        _calls.push({ method: 'captures.get', params: { captureKey } })
        return captureStore[captureKey]
      },
      set: async (captureKey: string, record: unknown) => {
        _calls.push({ method: 'captures.set', params: { captureKey, record } })
        captureStore[captureKey] = record
      },
    },
  }
}

// ---------------------------------------------------------------------------
// Route surface: every operation goes through the real ACP router
// (POST /v1/wrkf/pbc/tasks/:task/{run-step,approve-transition,run-until-blocked})
// with the fake port mounted as deps.wrkf — the wrkf daemon boundary.
// Each call gets a fresh wired server, so the route's own idempotency store
// never short-circuits a repeated call; harness-level dedupe stays observable.
// ---------------------------------------------------------------------------

type PbcRouteOp = 'run-step' | 'approve-transition' | 'run-until-blocked'

type PbcRouteResponse = { status: number; body: Record<string, unknown> }

async function postPbcRoute(
  port: FakePbcHarnessPort,
  op: PbcRouteOp,
  input: { task: string; routeKey?: string } & Record<string, unknown>
): Promise<PbcRouteResponse> {
  const { task, routeKey, ...rest } = input
  const body = routeKey !== undefined ? { ...rest, idempotencyKey: routeKey } : rest
  return withWiredServer(
    async (fixture) => {
      const response = await fixture.request({
        method: 'POST',
        path: `/v1/wrkf/pbc/tasks/${task}/${op}`,
        body,
      })
      return {
        status: response.status,
        body: await fixture.json<Record<string, unknown>>(response),
      }
    },
    { wrkf: port as unknown as AcpWrkfWorkflowPort }
  )
}

async function expectPbcRouteOk(
  port: FakePbcHarnessPort,
  op: PbcRouteOp,
  input: { task: string; routeKey?: string } & Record<string, unknown>
): Promise<PbcHarnessResult> {
  const response = await postPbcRoute(port, op, input)
  expect(response.status).toBe(200)
  return response.body as unknown as PbcHarnessResult
}

function runStepRoute(port: FakePbcHarnessPort, input: RunStepRequest) {
  return expectPbcRouteOk(port, 'run-step', { ...input })
}

function approveTransitionRoute(port: FakePbcHarnessPort, input: ApproveTransitionRequest) {
  return expectPbcRouteOk(port, 'approve-transition', { ...input })
}

function runUntilBlockedRoute(port: FakePbcHarnessPort, input: RunUntilBlockedRequest) {
  return expectPbcRouteOk(port, 'run-until-blocked', { ...input })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Verify result has latest revision + contextHash from the provided next raw. */
function assertHarnessResultRevision(
  result: PbcHarnessResult,
  expectedRevision: number,
  expectedContextHash: string
) {
  expect(result.instance.revision).toBe(expectedRevision)
  expect(result.instance.contextHash).toBe(expectedContextHash)
}

// ===========================================================================
// runStep
// ===========================================================================

describe('runStep', () => {
  // ── Wire names ─────────────────────────────────────────────────────────────

  test('run-step reads next with task only and never forwards actor', async () => {
    const port = makeFakePort()
    await runStepRoute(port, {
      task: 'T-00099',
      role: 'agent',
      actor: 'agent:pbc-writer',
      idempotencyKey: 'route-key-1',
      launchRuntime: false,
      participantOutput: { evidence: [] },
    } satisfies RunStepRequest)

    const nextCalls = port._calls.filter((c) => c.method === 'next')
    expect(nextCalls.length).toBeGreaterThan(0)
    for (const call of nextCalls) {
      const params = call.params as Record<string, unknown>
      expect(params['actor']).toBeUndefined()
      expect(params['task']).toBe('T-00099')
    }
  })

  // ── run.finish contract ─────────────────────────────────────────────────────

  test('run-step finishes the wrkf run without evidenceRefs, outcome or idempotencyKey', async () => {
    const port = makeFakePort()
    await runStepRoute(port, {
      task: 'T-00099',
      role: 'agent',
      actor: 'agent:pbc-writer',
      idempotencyKey: 'rk-1',
      launchRuntime: false,
      participantOutput: { evidence: [{ kind: 'intake_metadata' }] },
    } satisfies RunStepRequest)

    const finishCall = port._calls.find((c) => c.method === 'run.finish')
    expect(finishCall).toBeDefined()
    const params = finishCall!.params as Record<string, unknown>
    expect(params['evidenceRefs']).toBeUndefined()
    expect(params['outcome']).toBeUndefined()
    // idempotencyKey MUST NOT be passed to run.finish
    expect(params['idempotencyKey']).toBeUndefined()
  })

  test('run.finish is called ONLY after evidence/obligation processing succeeds (supplied mode)', async () => {
    const port = makeFakePort({
      nextSequence: [makeNextRaw({ revision: 0 }), makeNextRaw({ revision: 1 })],
    })
    await runStepRoute(port, {
      task: 'T-00001',
      role: 'agent',
      actor: 'agent:pbc-writer',
      idempotencyKey: 'rk-1',
      launchRuntime: false,
      participantOutput: {
        evidence: [{ kind: 'behavior_note', summary: 'user clicks thing' }],
      },
    } satisfies RunStepRequest)

    const callMethods = port._calls.map((c) => c.method)
    const evidenceIdx = callMethods.indexOf('evidence.add')
    const finishIdx = callMethods.indexOf('run.finish')
    expect(evidenceIdx).toBeGreaterThan(-1)
    expect(finishIdx).toBeGreaterThan(evidenceIdx)
  })

  // ── No transition before output ingested ────────────────────────────────────

  test('transitionPolicy=none ingests evidence and applies no transition even with one legal action', async () => {
    const port = makeFakePort({
      nextSequence: [
        makeNextRaw({
          status: 'open',
          phase: 'intake',
          revision: 0,
          actions: [{ transition: 'normalize_feedback' }],
        }),
      ],
    })
    await runStepRoute(port, {
      task: 'T-00001',
      role: 'agent',
      actor: 'agent:pbc-writer',
      idempotencyKey: 'rk-1',
      launchRuntime: false,
      participantOutput: { evidence: [{ kind: 'intake_metadata' }] },
      transitionPolicy: 'none',
    } satisfies RunStepRequest)

    expect(port._calls.filter((c) => c.method === 'evidence.add')).toHaveLength(1)
    const transitionCall = port._calls.find((c) => c.method === 'transition.apply')
    expect(transitionCall).toBeUndefined()
  })

  test('does NOT apply transition before participant output ingested in launched-runtime mode', async () => {
    const port = makeFakePort({
      nextSequence: [
        makeNextRaw({
          status: 'open',
          phase: 'intake',
          revision: 0,
          actions: [{ transition: 'normalize_feedback' }],
        }),
      ],
    })
    const result = await runStepRoute(port, {
      task: 'T-00001',
      role: 'agent',
      actor: 'agent:pbc-writer',
      idempotencyKey: 'rk-1',
      launchRuntime: true,
      transitionPolicy: 'single-safe',
    } satisfies RunStepRequest)

    // No transition applied in launched-runtime mode (output not yet available)
    const transitionCall = port._calls.find((c) => c.method === 'transition.apply')
    expect(transitionCall).toBeUndefined()
    // Result should NOT have a committed transition
    expect(result.transitionApplied).toBeUndefined()
  })

  // ── transitionPolicy=single-safe ────────────────────────────────────────────

  test('applies transition when transitionPolicy=single-safe and exactly one legal action (supplied mode)', async () => {
    const port = makeFakePort({
      nextSequence: [
        // first next (before run.start)
        makeNextRaw({
          status: 'open',
          phase: 'intake',
          revision: 0,
          contextHash: 'sha256:ctx0',
          actions: [{ transition: 'normalize_feedback' }],
        }),
        // second next (after evidence ingest, before transition)
        makeNextRaw({
          status: 'open',
          phase: 'intake',
          revision: 1,
          contextHash: 'sha256:ctx1',
          actions: [{ transition: 'normalize_feedback' }],
        }),
      ],
    })

    const result = await runStepRoute(port, {
      task: 'T-00001',
      role: 'agent',
      actor: 'agent:pbc-writer',
      idempotencyKey: 'rk-2',
      launchRuntime: false,
      participantOutput: { evidence: [{ kind: 'intake_metadata' }] },
      transitionPolicy: 'single-safe',
    } satisfies RunStepRequest)

    const transitionCall = port._calls.find((c) => c.method === 'transition.apply')
    expect(transitionCall).toBeDefined()
    const params = transitionCall!.params as Record<string, unknown>
    expect(params['transition']).toBe('normalize_feedback')
    // Must use fresh revision+contextHash from re-read next
    expect(params['expectRevision']).toBe(1)
    expect(params['contextHash']).toBe('sha256:ctx1')
    expect(result.transitionApplied).toBeDefined()
  })

  test.each([
    {
      label: 'zero legal actions',
      status: 'waiting',
      phase: 'clarification',
      actions: [] as Array<{ transition: string }>,
    },
    {
      label: 'two ambiguous legal actions',
      status: 'active',
      phase: 'behavior_note',
      actions: [{ transition: 'ask_clarification' }, { transition: 'draft_pbc' }],
    },
  ])('single-safe applies no transition with $label', async ({ status, phase, actions }) => {
    const port = makeFakePort({
      nextSequence: [
        makeNextRaw({ status, phase, revision: 1, actions }),
        makeNextRaw({ status, phase, revision: 2, actions }),
      ],
    })
    const result = await runStepRoute(port, {
      task: 'T-00001',
      role: 'agent',
      actor: 'agent:pbc-writer',
      idempotencyKey: 'rk-4',
      launchRuntime: false,
      participantOutput: {
        evidence: [{ kind: 'pre_interview_analysis', facts: { clarification_needed: false } }],
      },
      transitionPolicy: 'single-safe',
    } satisfies RunStepRequest)

    // The harness must not pick one arbitrarily (or invent one when none is legal)
    expect(port._calls.some((c) => c.method === 'transition.apply')).toBe(false)
    expect(result.transitionApplied).toBeUndefined()
  })

  // ── Effect delivery after transition ────────────────────────────────────────

  test('delivers effects after a committed transition (single-safe)', async () => {
    const port = makeFakePort({
      nextSequence: [
        makeNextRaw({
          status: 'open',
          phase: 'intake',
          revision: 0,
          actions: [{ transition: 'normalize_feedback' }],
        }),
        makeNextRaw({
          status: 'open',
          phase: 'intake',
          revision: 1,
          actions: [{ transition: 'normalize_feedback' }],
        }),
      ],
      effects: [{ id: 'eff_001', kind: 'set_task_state', status: 'pending' }],
    })

    await runStepRoute(port, {
      task: 'T-00001',
      role: 'agent',
      actor: 'agent:pbc-writer',
      idempotencyKey: 'rk-5',
      launchRuntime: false,
      participantOutput: { evidence: [{ kind: 'intake_metadata' }] },
      transitionPolicy: 'single-safe',
    } satisfies RunStepRequest)

    const callMethods = port._calls.map((c) => c.method)
    const transitionIdx = callMethods.indexOf('transition.apply')
    const effectListIdx = callMethods.indexOf('effect.list')
    const effectDeliverIdx = callMethods.indexOf('effect.deliver')

    expect(transitionIdx).toBeGreaterThan(-1)
    expect(effectListIdx).toBeGreaterThan(transitionIdx)
    expect(effectDeliverIdx).toBeGreaterThan(effectListIdx)
  })

  test('does NOT call effect.deliver when no transition was applied', async () => {
    const port = makeFakePort({
      effects: [{ id: 'eff_001', kind: 'set_task_state', status: 'pending' }],
    })
    await runStepRoute(port, {
      task: 'T-00001',
      role: 'agent',
      actor: 'agent:pbc-writer',
      idempotencyKey: 'rk-6',
      launchRuntime: false,
      participantOutput: { evidence: [] },
      transitionPolicy: 'none',
    } satisfies RunStepRequest)

    // No transition → no effect delivery
    const deliverCall = port._calls.find((c) => c.method === 'effect.deliver')
    expect(deliverCall).toBeUndefined()
  })

  // ── PbcHarnessResult structure ──────────────────────────────────────────────

  test('result.instance has latest revision+contextHash after evidence write', async () => {
    const freshNext = makeNextRaw({ revision: 2, contextHash: 'sha256:ctx2' })
    const port = makeFakePort({
      nextSequence: [makeNextRaw({ revision: 1, contextHash: 'sha256:ctx1' }), freshNext],
    })
    const result = await runStepRoute(port, {
      task: 'T-00001',
      role: 'agent',
      actor: 'agent:pbc-writer',
      idempotencyKey: 'rk-7',
      launchRuntime: false,
      participantOutput: { evidence: [{ kind: 'intake_metadata' }] },
      transitionPolicy: 'none',
    } satisfies RunStepRequest)

    // Result must reflect the FRESHEST next read (after evidence ingest)
    assertHarnessResultRevision(result, 2, 'sha256:ctx2')
  })

  test('result.runs.started is populated from run.start response', async () => {
    const port = makeFakePort()
    const result = await runStepRoute(port, {
      task: 'T-00001',
      role: 'agent',
      actor: 'agent:pbc-writer',
      idempotencyKey: 'rk-10',
      launchRuntime: false,
      participantOutput: { evidence: [] },
    } satisfies RunStepRequest)
    expect(result.runs.started).toBeDefined()
    expect((result.runs.started as Record<string, unknown>)['id']).toBe('run_fake_1')
  })

  test('result.evidenceAdded reflects all ingested evidence', async () => {
    const port = makeFakePort()
    const result = await runStepRoute(port, {
      task: 'T-00001',
      role: 'agent',
      actor: 'agent:pbc-writer',
      idempotencyKey: 'rk-11',
      launchRuntime: false,
      participantOutput: {
        evidence: [
          { kind: 'intake_metadata' },
          { kind: 'behavior_note', summary: 'clicking button' },
        ],
      },
    } satisfies RunStepRequest)
    expect(result.evidenceAdded).toHaveLength(2)
  })

  // ── Idempotency: captureKey prevents duplicate evidence ─────────────────────

  test('repeated runStep with same idempotencyKey does NOT duplicate evidence (already_captured)', async () => {
    const captureStore: Record<string, unknown> = {}
    const port = makeFakePort({ captureStore })

    const input: RunStepRequest = {
      task: 'T-00001',
      role: 'agent',
      actor: 'agent:pbc-writer',
      idempotencyKey: 'rk-idem-1',
      launchRuntime: false,
      participantOutput: { evidence: [{ kind: 'intake_metadata' }] },
    }

    // First call
    await runStepRoute(port, input)
    const firstCallCount = port._calls.filter((c) => c.method === 'evidence.add').length

    // Second call with SAME idempotencyKey
    await runStepRoute(port, input)
    const secondCallCount = port._calls.filter((c) => c.method === 'evidence.add').length

    // evidence.add must NOT be called again on replay
    expect(secondCallCount).toBe(firstCallCount)
  })

  // ── run.fail if evidence ingestion fails ───────────────────────────────────

  test('calls run.fail if evidence ingestion throws (no orphaned open run)', async () => {
    const _calls: SpyCall[] = []
    let runId = ''
    const port: FakePbcHarnessPort = {
      ...makeFakePort(),
      _calls,
      run: {
        start: async (params) => {
          _calls.push({ method: 'run.start', params })
          runId = 'run_fail_test'
          return makeRunRecord(runId)
        },
        finish: async (params) => {
          _calls.push({ method: 'run.finish', params })
          return makeRunRecord(params.runId)
        },
        fail: async (params) => {
          _calls.push({ method: 'run.fail', params })
          return makeRunRecord(params.runId)
        },
        bindExternal: async (params) => {
          _calls.push({ method: 'run.bindExternal', params })
          return makeRunRecord(String(params['runId'] ?? 'run_ext'))
        },
      },
      evidence: {
        add: async (params) => {
          _calls.push({ method: 'evidence.add', params })
          throw new Error('evidence.add failed: invalid kind')
        },
      },
    } as unknown as FakePbcHarnessPort

    const response = await postPbcRoute(port, 'run-step', {
      task: 'T-00001',
      role: 'agent',
      actor: 'agent:pbc-writer',
      idempotencyKey: 'rk-fail-1',
      launchRuntime: false,
      participantOutput: { evidence: [{ kind: 'bad_kind' }] },
    } satisfies RunStepRequest)
    expect(response.status).toBe(500)
    expect(JSON.stringify(response.body)).toContain('evidence.add failed: invalid kind')

    const failCall = _calls.find((c) => c.method === 'run.fail')
    expect(failCall).toBeDefined()
    expect((failCall!.params as Record<string, unknown>)['runId']).toBe(runId)
    // run.finish must NOT be called after a failure
    const finishCall = _calls.find((c) => c.method === 'run.finish')
    expect(finishCall).toBeUndefined()
  })
})

// ===========================================================================
// approveTransition
// ===========================================================================

describe('approveTransition', () => {
  // ── Re-read next immediately before apply ──────────────────────────────────

  test('approve-transition re-reads next and applies with its revision and contextHash under wrkf wire names', async () => {
    const port = makeFakePort({
      nextSequence: [makeNextRaw({ revision: 7, contextHash: 'sha256:ctx7' })],
    })
    await approveTransitionRoute(port, {
      task: 'T-00001',
      transition: 'run_pressure_pass',
      actor: 'human:operator',
      routeKey: 'approve-rk-2',
    } satisfies ApproveTransitionRequest)

    // next is re-read before the apply (fresh CAS)
    const callMethods = port._calls.map((c) => c.method)
    expect(callMethods.indexOf('next')).toBeGreaterThan(-1)
    expect(callMethods.indexOf('transition.apply')).toBeGreaterThan(callMethods.indexOf('next'))
    const applyCall = port._calls.find((c) => c.method === 'transition.apply')
    expect(applyCall).toBeDefined()
    const params = applyCall!.params as Record<string, unknown>
    expect(params['expectRevision']).toBe(7)
    expect(params['contextHash']).toBe('sha256:ctx7')
    // wrkf wire names: task + transition, never taskId / transitionId
    expect(params['task']).toBe('T-00001')
    expect(params['taskId']).toBeUndefined()
    expect(params['transition']).toBe('run_pressure_pass')
    expect(params['transitionId']).toBeUndefined()
  })

  // ── Deterministic idempotency key ──────────────────────────────────────────

  test('idempotency key is {routeKey}:transition:{transition}:{revision}', async () => {
    const port = makeFakePort({
      nextSequence: [makeNextRaw({ revision: 3, contextHash: 'sha256:ctx3' })],
    })
    await approveTransitionRoute(port, {
      task: 'T-00001',
      transition: 'finalize_ready_pbc',
      actor: 'human:operator',
      routeKey: 'approve-rk-99',
    } satisfies ApproveTransitionRequest)

    const applyCall = port._calls.find((c) => c.method === 'transition.apply')
    expect(applyCall).toBeDefined()
    const params = applyCall!.params as Record<string, unknown>
    expect(params['idempotencyKey']).toBe('approve-rk-99:transition:finalize_ready_pbc:3')
  })

  // ── runChecks forwarded ────────────────────────────────────────────────────

  test('forwards runChecks=true to transition.apply when requested', async () => {
    const port = makeFakePort({
      nextSequence: [makeNextRaw({ revision: 2 })],
    })
    await approveTransitionRoute(port, {
      task: 'T-00001',
      transition: 'normalize_feedback',
      actor: 'human:operator',
      routeKey: 'approve-rk-3',
      runChecks: true,
    } satisfies ApproveTransitionRequest)

    const applyCall = port._calls.find((c) => c.method === 'transition.apply')
    expect(applyCall).toBeDefined()
    expect((applyCall!.params as Record<string, unknown>)['runChecks']).toBe(true)
  })

  test('defaults runChecks=false when not specified', async () => {
    const port = makeFakePort({
      nextSequence: [makeNextRaw({ revision: 1 })],
    })
    await approveTransitionRoute(port, {
      task: 'T-00001',
      transition: 'normalize_feedback',
      actor: 'human:operator',
      routeKey: 'approve-rk-4',
    } satisfies ApproveTransitionRequest)

    const applyCall = port._calls.find((c) => c.method === 'transition.apply')
    expect(applyCall).toBeDefined()
    const params = applyCall!.params as Record<string, unknown>
    // default is false
    expect(params['runChecks']).toBe(false)
  })

  // ── Effect delivery after transition ────────────────────────────────────────

  test('delivers pending effects after committed transition', async () => {
    const port = makeFakePort({
      nextSequence: [makeNextRaw({ revision: 5 })],
      effects: [
        { id: 'eff_100', kind: 'set_task_state', status: 'pending' },
        { id: 'eff_101', kind: 'set_task_state', status: 'pending' },
      ],
    })
    const result = await approveTransitionRoute(port, {
      task: 'T-00001',
      transition: 'finalize_ready_pbc',
      actor: 'human:operator',
      routeKey: 'approve-rk-5',
    } satisfies ApproveTransitionRequest)

    expect(result.effectsDelivered).toHaveLength(2)
    expect(result.effectsDelivered.map((e) => (e as Record<string, unknown>)['id'])).toContain(
      'eff_100'
    )
    expect(result.effectsDelivered.map((e) => (e as Record<string, unknown>)['id'])).toContain(
      'eff_101'
    )
  })

  // ── Result model ─────────────────────────────────────────────────────────

  test('result includes latest revision+contextHash after transition', async () => {
    const port = makeFakePort({
      nextSequence: [makeNextRaw({ revision: 8, contextHash: 'sha256:ctx8' })],
    })
    const result = await approveTransitionRoute(port, {
      task: 'T-00099',
      transition: 'normalize_feedback',
      actor: 'human:operator',
      routeKey: 'approve-rk-6',
    } satisfies ApproveTransitionRequest)

    // Must include current revision (from the re-read next, which is the freshest known)
    assertHarnessResultRevision(result, 8, 'sha256:ctx8')
    expect(result.transitionApplied).toBeDefined()
    expect(result.task).toBe('T-00099')
  })

  // ── Wire names ─────────────────────────────────────────────────────────────

  // ── Stale revision: single retry ───────────────────────────────────────────

  test('on WRKF_STALE_REVISION re-reads next once and retries transition', async () => {
    let applyCallCount = 0
    const port = makeFakePort({
      nextSequence: [
        makeNextRaw({ revision: 3, contextHash: 'sha256:stale' }),
        makeNextRaw({ revision: 4, contextHash: 'sha256:fresh' }),
      ],
      transitionShouldThrow: (_t) => {
        applyCallCount++
        if (applyCallCount === 1) {
          const err = new Error('WRKF_STALE_REVISION') as Error & { code: string }
          err.code = 'WRKF_STALE_REVISION'
          return err
        }
        return undefined
      },
    })
    const result = await approveTransitionRoute(port, {
      task: 'T-00001',
      transition: 'normalize_feedback',
      actor: 'human:operator',
      routeKey: 'approve-rk-stale',
    } satisfies ApproveTransitionRequest)

    // Should have retried once with fresh revision
    expect(applyCallCount).toBe(2)
    const applyCalls = port._calls.filter((c) => c.method === 'transition.apply')
    // Second apply uses the fresh revision
    const secondApplyParams = applyCalls[1]!.params as Record<string, unknown>
    expect(secondApplyParams['expectRevision']).toBe(4)
    expect(secondApplyParams['contextHash']).toBe('sha256:fresh')
    expect(result.transitionApplied).toBeDefined()
  })

  test('does NOT retry a second time on repeated WRKF_STALE_REVISION', async () => {
    let applyCallCount = 0
    const port = makeFakePort({
      nextSequence: [makeNextRaw({ revision: 3 }), makeNextRaw({ revision: 4 })],
      transitionShouldThrow: () => {
        applyCallCount++
        const err = new Error('WRKF_STALE_REVISION') as Error & { code: string }
        err.code = 'WRKF_STALE_REVISION'
        return err
      },
    })

    const response = await postPbcRoute(port, 'approve-transition', {
      task: 'T-00001',
      transition: 'normalize_feedback',
      actor: 'human:operator',
      routeKey: 'approve-rk-stale2',
    } satisfies ApproveTransitionRequest)
    expect(response.status).toBe(409)
    expect((response.body['error'] as Record<string, unknown>)['code']).toBe('WRKF_STALE_REVISION')

    expect(applyCallCount).toBe(2) // exactly 1 retry
  })

  test('transition.apply uses `task` wire name, not `taskId`', async () => {
    const port = makeFakePort({
      nextSequence: [makeNextRaw({ revision: 0 })],
    })
    await approveTransitionRoute(port, {
      task: 'T-00088',
      transition: 'normalize_feedback',
      actor: 'human:operator',
      routeKey: 'approve-rk-7',
    } satisfies ApproveTransitionRequest)

    const applyCall = port._calls.find((c) => c.method === 'transition.apply')
    expect(applyCall).toBeDefined()
    const params = applyCall!.params as Record<string, unknown>
    expect(params['task']).toBe('T-00088')
    expect(params['taskId']).toBeUndefined()
    expect(params['transition']).toBeDefined()
    expect(params['transitionId']).toBeUndefined()
  })
})

// ===========================================================================
// runUntilBlocked
// ===========================================================================

describe('runUntilBlocked', () => {
  // ── closed: stop immediately ───────────────────────────────────────────────

  test('stops immediately when instance is already closed', async () => {
    const port = makeFakePort({
      nextSequence: [
        makeNextRaw({ status: 'closed', phase: 'finalized', revision: 10, actions: [] }),
      ],
    })
    const result = await runUntilBlockedRoute(port, {
      task: 'T-00001',
      actor: 'agent:pbc-writer',
      idempotencyKey: 'autopilot-1',
    } satisfies RunUntilBlockedRequest)

    expect(result.stopReason).toBe('closed')
    expect(result.workflowRef).toBe('pbc-progressive-refinement@9')
    // No run.start when instance is already closed
    expect(port._calls.find((c) => c.method === 'run.start')).toBeUndefined()
  })

  // ── stale flag is diagnostics-only ────────────────────────────────────────

  test('ignores next.instance.stale and uses the real blocking reason', async () => {
    const port = makeFakePort({
      nextSequence: [
        makeNextRaw({
          status: 'open',
          phase: 'intake',
          revision: 1,
          stale: true,
          actions: [],
        }),
      ],
    })
    const result = await runUntilBlockedRoute(port, {
      task: 'T-00001',
      actor: 'agent:pbc-writer',
      idempotencyKey: 'autopilot-stale',
      maxTurns: 1,
    } satisfies RunUntilBlockedRequest)

    expect(result.stopReason).toBe('blocked_or_ambiguous')
    expect(result.instance.stale).toBe(true)
  })

  // ── max_turns ─────────────────────────────────────────────────────────────

  test('stops at maxTurns and returns max_turns stop reason', async () => {
    // Always return a legal action so autopilot never blocks
    const alwaysNext = makeNextRaw({
      status: 'open',
      phase: 'intake',
      revision: 0,
      actions: [{ transition: 'normalize_feedback' }],
    })
    const port = makeFakePort({
      nextSequence: Array.from({ length: 20 }, () => alwaysNext),
    })

    const result = await runUntilBlockedRoute(port, {
      task: 'T-00001',
      actor: 'agent:pbc-writer',
      idempotencyKey: 'autopilot-maxturn',
      maxTurns: 2,
    } satisfies RunUntilBlockedRequest)

    expect(result.stopReason).toBe('max_turns')
  })

  // ── requires_product_owner_clarification ───────────────────────────────────

  test('stops with requires_product_owner_clarification in waiting/clarification without simulation', async () => {
    const port = makeFakePort({
      nextSequence: [
        makeNextRaw({
          status: 'waiting',
          phase: 'clarification',
          revision: 3,
          actions: [],
          openObligations: [{ id: 'obl_001', kind: 'clarification_response', status: 'open' }],
        }),
      ],
    })
    const result = await runUntilBlockedRoute(port, {
      task: 'T-00001',
      actor: 'agent:pbc-writer',
      idempotencyKey: 'autopilot-clarif',
    } satisfies RunUntilBlockedRequest)

    expect(result.stopReason).toBe('requires_product_owner_clarification')
  })

  // ── requires_product_owner_patch_decision ──────────────────────────────────

  test('stops with requires_product_owner_patch_decision in waiting/patch_decision without simulation', async () => {
    const port = makeFakePort({
      nextSequence: [
        makeNextRaw({
          status: 'waiting',
          phase: 'patch_decision',
          revision: 5,
          actions: [],
          openObligations: [{ id: 'obl_002', kind: 'patch_decision', status: 'open' }],
        }),
      ],
    })
    const result = await runUntilBlockedRoute(port, {
      task: 'T-00001',
      actor: 'agent:pbc-writer',
      idempotencyKey: 'autopilot-patch',
    } satisfies RunUntilBlockedRequest)

    expect(result.stopReason).toBe('requires_product_owner_patch_decision')
  })

  // ── blocked_or_ambiguous ──────────────────────────────────────────────────

  test('stops with blocked_or_ambiguous when no single safe transition can be chosen', async () => {
    const port = makeFakePort({
      nextSequence: [
        // Initial next
        makeNextRaw({
          status: 'active',
          phase: 'behavior_note',
          revision: 2,
          actions: [{ transition: 'ask_clarification' }, { transition: 'draft_pbc' }],
        }),
        // After evidence ingest (still ambiguous)
        makeNextRaw({
          status: 'active',
          phase: 'behavior_note',
          revision: 3,
          actions: [{ transition: 'ask_clarification' }, { transition: 'draft_pbc' }],
        }),
      ],
    })
    const result = await runUntilBlockedRoute(port, {
      task: 'T-00001',
      actor: 'agent:pbc-writer',
      idempotencyKey: 'autopilot-ambig',
      maxTurns: 1,
    } satisfies RunUntilBlockedRequest)

    expect(result.stopReason).toBe('blocked_or_ambiguous')
  })

  // ── requires_distinct_pressure_reviewer (SoD violation) ───────────────────

  test('stops with requires_distinct_pressure_reviewer when pressure and draft actor are same', async () => {
    // State is active/pressure: autopilot would try finalize_ready_pbc with verdict=ready
    // but draft actor === pressure actor → SoD violation
    const port = makeFakePort({
      nextSequence: [
        makeNextRaw({
          status: 'active',
          phase: 'pressure',
          revision: 4,
          actions: [{ transition: 'finalize_ready_pbc' }],
        }),
        // After evidence ingest
        makeNextRaw({
          status: 'active',
          phase: 'pressure',
          revision: 5,
          actions: [{ transition: 'finalize_ready_pbc' }],
        }),
      ],
    })

    // Same actor for draft and pressure — SoD violation
    const result = await runUntilBlockedRoute(port, {
      task: 'T-00001',
      actor: 'agent:pbc-writer', // same actor for both roles
      pressureActor: 'agent:pbc-writer', // SAME as actor → SoD violation
      idempotencyKey: 'autopilot-sod',
    } satisfies RunUntilBlockedRequest)

    expect(result.stopReason).toBe('requires_distinct_pressure_reviewer')
  })

  test('does NOT stop for SoD when pressureActor differs from draft actor', async () => {
    // Provide distinct actors; autopilot should apply finalize_ready_pbc
    const port = makeFakePort({
      evidence: [
        makeEvidenceSnapshot('ev_draft_1', 'pbc_draft'),
        makeEvidenceSnapshot('ev_pp_1', 'pressure_pass', {
          facts: { verdict: 'ready' },
          data: { reviewedDraftEvidenceId: 'ev_draft_1' },
        }),
        makeEvidenceSnapshot('ev_final_1', 'pbc_final', {
          data: {
            basedOnDraftEvidenceId: 'ev_draft_1',
            basedOnPressurePassEvidenceId: 'ev_pp_1',
          },
        }),
      ],
      nextSequence: [
        makeNextRaw({
          status: 'active',
          phase: 'pressure',
          revision: 4,
          actions: [{ transition: 'finalize_ready_pbc' }],
        }),
        makeNextRaw({
          status: 'active',
          phase: 'pressure',
          revision: 5,
          actions: [{ transition: 'finalize_ready_pbc' }],
        }),
        // After transition, closed
        makeNextRaw({
          status: 'closed',
          phase: 'finalized',
          revision: 6,
          actions: [],
        }),
      ],
    })

    const result = await runUntilBlockedRoute(port, {
      task: 'T-00001',
      actor: 'agent:pbc-writer',
      pressureActor: 'agent:pressure-reviewer', // distinct
      idempotencyKey: 'autopilot-sod-ok',
      maxTurns: 5,
    } satisfies RunUntilBlockedRequest)

    // Finalizes and stops as closed, not as an SoD violation
    expect(result.stopReason).toBe('closed')
    const finalizeCall = port._calls.find(
      (c) =>
        c.method === 'transition.apply' &&
        (c.params as Record<string, unknown>)['transition'] === 'finalize_ready_pbc'
    )
    expect(finalizeCall).toBeDefined()
  })

  // ── Disposition gating ────────────────────────────────────────────────────

  test('does NOT choose dispose_from_behavior_note without allowDisposition=true', async () => {
    const port = makeFakePort({
      nextSequence: [
        makeNextRaw({
          status: 'active',
          phase: 'behavior_note',
          revision: 2,
          actions: [{ transition: 'dispose_from_behavior_note' }],
        }),
        // After run step (still only disposition available)
        makeNextRaw({
          status: 'active',
          phase: 'behavior_note',
          revision: 3,
          actions: [{ transition: 'dispose_from_behavior_note' }],
        }),
      ],
    })

    const result = await runUntilBlockedRoute(port, {
      task: 'T-00001',
      actor: 'agent:pbc-writer',
      idempotencyKey: 'autopilot-disp',
      maxTurns: 1,
    } satisfies RunUntilBlockedRequest)

    // Must stop rather than apply a disposition without explicit approval
    expect(result.stopReason).toBe('blocked_or_ambiguous')
    const dispositionCall = port._calls.find(
      (c) =>
        c.method === 'transition.apply' &&
        (c.params as Record<string, unknown>)['transition'] === 'dispose_from_behavior_note'
    )
    expect(dispositionCall).toBeUndefined()
  })

  test('applies dispose_from_behavior_note when allowDisposition=true', async () => {
    const port = makeFakePort({
      nextSequence: [
        makeNextRaw({
          status: 'active',
          phase: 'behavior_note',
          revision: 2,
          actions: [{ transition: 'dispose_from_behavior_note' }],
        }),
        makeNextRaw({
          status: 'active',
          phase: 'behavior_note',
          revision: 3,
          actions: [{ transition: 'dispose_from_behavior_note' }],
        }),
        makeNextRaw({
          status: 'closed',
          phase: 'disposed',
          revision: 4,
          actions: [],
        }),
      ],
    })

    const result = await runUntilBlockedRoute(port, {
      task: 'T-00001',
      actor: 'agent:pbc-writer',
      idempotencyKey: 'autopilot-disp-ok',
      allowDisposition: true,
      maxTurns: 3,
    } satisfies RunUntilBlockedRequest)

    const dispositionCall = port._calls.find(
      (c) =>
        c.method === 'transition.apply' &&
        (c.params as Record<string, unknown>)['transition'] === 'dispose_from_behavior_note'
    )
    expect(dispositionCall).toBeDefined()
    expect(result.stopReason).toBe('closed')
  })

  // ── Effect delivery after each transition ──────────────────────────────────

  // ── Obligation before transition: clarification path ──────────────────────

  test('obligation.satisfy called before answer_clarification transition', async () => {
    const port = makeFakePort({
      nextSequence: [
        makeNextRaw({
          status: 'waiting',
          phase: 'clarification',
          revision: 3,
          actions: [{ transition: 'answer_clarification' }],
          openObligations: [{ id: 'obl_clarifA', kind: 'clarification_response', status: 'open' }],
        }),
        // Re-read by the evidence writer after the obligation is satisfied
        makeNextRaw({
          status: 'waiting',
          phase: 'clarification',
          revision: 4,
          actions: [{ transition: 'answer_clarification' }],
          openObligations: [],
        }),
        // Fresh read the autopilot chooses from
        makeNextRaw({
          status: 'waiting',
          phase: 'clarification',
          revision: 4,
          actions: [{ transition: 'answer_clarification' }],
          openObligations: [],
        }),
        // After transition
        makeNextRaw({
          status: 'closed',
          phase: 'finalized',
          revision: 5,
          actions: [],
        }),
      ],
      obligations: [{ id: 'obl_clarifA', kind: 'clarification_response', status: 'open' }],
    })

    const result = await runUntilBlockedRoute(port, {
      task: 'T-00001',
      actor: 'agent:pbc-writer',
      idempotencyKey: 'autopilot-clarif-ob',
      allowProductOwnerSimulation: true,
      maxTurns: 3,
    } satisfies RunUntilBlockedRequest)

    const callMethods = port._calls.map((c) => c.method)
    const satisfyIdx = callMethods.lastIndexOf('obligation.satisfy')
    const applyIdx = callMethods.lastIndexOf('transition.apply')

    // obligation.satisfy must come BEFORE transition.apply for answer_clarification
    expect(applyIdx).toBeGreaterThan(-1)
    expect((port._calls[applyIdx]!.params as Record<string, unknown>)['transition']).toBe(
      'answer_clarification'
    )
    expect(satisfyIdx).toBeGreaterThan(-1)
    expect(satisfyIdx).toBeLessThan(applyIdx)
    expect(result.stopReason).toBe('closed')
  })

  test('obligation.satisfy called before patch-decision transitions (patch_decision path)', async () => {
    const port = makeFakePort({
      // Fresh draft -> pressure pass -> final chain so finalization passes freshness;
      // the simulated patch_decision (route=finalize) is appended by the autopilot.
      evidence: [
        makeEvidenceSnapshot('ev_draft_1', 'pbc_draft'),
        makeEvidenceSnapshot('ev_pp_1', 'pressure_pass', {
          facts: { verdict: 'needs_patch' },
          data: { reviewedDraftEvidenceId: 'ev_draft_1' },
        }),
        makeEvidenceSnapshot('ev_final_1', 'pbc_final', {
          data: {
            basedOnDraftEvidenceId: 'ev_draft_1',
            basedOnPressurePassEvidenceId: 'ev_pp_1',
          },
        }),
      ],
      nextSequence: [
        makeNextRaw({
          status: 'waiting',
          phase: 'patch_decision',
          revision: 5,
          actions: [{ transition: 'finalize_after_patch_decision' }],
          openObligations: [{ id: 'obl_patchB', kind: 'patch_decision', status: 'open' }],
        }),
        // Re-read by the evidence writer after the obligation is satisfied
        makeNextRaw({
          status: 'waiting',
          phase: 'patch_decision',
          revision: 6,
          actions: [{ transition: 'finalize_after_patch_decision' }],
          openObligations: [],
        }),
        // Fresh read the autopilot chooses from
        makeNextRaw({
          status: 'waiting',
          phase: 'patch_decision',
          revision: 6,
          actions: [{ transition: 'finalize_after_patch_decision' }],
          openObligations: [],
        }),
        makeNextRaw({
          status: 'closed',
          phase: 'finalized',
          revision: 7,
          actions: [],
        }),
      ],
      obligations: [{ id: 'obl_patchB', kind: 'patch_decision', status: 'open' }],
    })

    const result = await runUntilBlockedRoute(port, {
      task: 'T-00001',
      actor: 'agent:pbc-writer',
      pressureActor: 'agent:pressure-reviewer',
      idempotencyKey: 'autopilot-patch-ob',
      allowProductOwnerSimulation: true,
      maxTurns: 4,
    } satisfies RunUntilBlockedRequest)

    const callMethods = port._calls.map((c) => c.method)
    const satisfyIdx = callMethods.lastIndexOf('obligation.satisfy')
    const applyIdx = callMethods.lastIndexOf('transition.apply')
    expect(applyIdx).toBeGreaterThan(-1)
    expect((port._calls[applyIdx]!.params as Record<string, unknown>)['transition']).toBe(
      'finalize_after_patch_decision'
    )
    expect(satisfyIdx).toBeGreaterThan(-1)
    expect(satisfyIdx).toBeLessThan(applyIdx)
    expect(result.stopReason).toBe('closed')
  })

  // ── Re-read next after every write ────────────────────────────────────────

  test('re-reads next after evidence ingest before applying transition', async () => {
    const port = makeFakePort({
      nextSequence: [
        // Initial next
        makeNextRaw({
          status: 'open',
          phase: 'intake',
          revision: 0,
          contextHash: 'sha256:ctx0',
          actions: [{ transition: 'normalize_feedback' }],
        }),
        // After evidence add (fresh contextHash)
        makeNextRaw({
          status: 'open',
          phase: 'intake',
          revision: 1,
          contextHash: 'sha256:ctx1',
          actions: [{ transition: 'normalize_feedback' }],
        }),
        // Post-transition
        makeNextRaw({
          status: 'closed',
          phase: 'finalized',
          revision: 2,
          actions: [],
        }),
      ],
    })

    await runUntilBlockedRoute(port, {
      task: 'T-00001',
      actor: 'agent:pbc-writer',
      idempotencyKey: 'autopilot-reread',
      maxTurns: 3,
    } satisfies RunUntilBlockedRequest)

    // open/intake applies normalize_feedback, using the contextHash from the
    // re-read next (sha256:ctx1, not sha256:ctx0)
    const applyCall = port._calls.find((c) => c.method === 'transition.apply')
    expect(applyCall).toBeDefined()
    const params = applyCall!.params as Record<string, unknown>
    expect(params['transition']).toBe('normalize_feedback')
    expect(params['contextHash']).toBe('sha256:ctx1')
    expect(params['expectRevision']).toBe(1)
  })

  // ── set_task_state delivery: list then deliver(effectId) ─────────────────

  test('effect delivery calls effect.list then effect.deliver for each pending effect', async () => {
    const port = makeFakePort({
      nextSequence: [
        makeNextRaw({
          status: 'open',
          phase: 'intake',
          revision: 0,
          actions: [{ transition: 'normalize_feedback' }],
        }),
        makeNextRaw({
          status: 'open',
          phase: 'intake',
          revision: 1,
          actions: [{ transition: 'normalize_feedback' }],
        }),
        makeNextRaw({
          status: 'closed',
          phase: 'finalized',
          revision: 2,
          actions: [],
        }),
      ],
      effects: [{ id: 'eff_set_1', kind: 'set_task_state', status: 'pending' }],
    })

    await runUntilBlockedRoute(port, {
      task: 'T-00001',
      actor: 'agent:pbc-writer',
      idempotencyKey: 'autopilot-deliver',
      maxTurns: 4,
    } satisfies RunUntilBlockedRequest)

    const listCall = port._calls.find((c) => c.method === 'effect.list')
    expect(listCall).toBeDefined()

    const deliverCall = port._calls.find((c) => c.method === 'effect.deliver')
    expect(deliverCall).toBeDefined()
    const deliverParams = deliverCall!.params as Record<string, unknown>
    // NEVER passes task to effect.deliver — only effectId + adapter
    expect(deliverParams['effectId']).toBe('eff_set_1')
    expect(deliverParams['adapter']).toBe('acp')
    expect(deliverParams['task']).toBeUndefined()
  })

  // ── PbcHarnessResult ─────────────────────────────────────────────────────

  // ── State policy: open/intake → normalize_feedback ────────────────────────
})
