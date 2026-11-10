// PBC run-step contract exercised through the real ACP HTTP router.
import { describe, expect, test } from 'bun:test'

import { makeFakePort, makeNextRaw } from '../../test/fixtures/pbc-harness-port.js'
import { postPbcRoute, runStepRoute } from '../../test/fixtures/pbc-harness-routes.js'
import type { RunStepRequest } from './pbc-harness.js'

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
    expect(result.instance.revision).toBe(2)
    expect(result.instance.contextHash).toBe('sha256:ctx2')
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
    const port = makeFakePort()
    const _calls = port._calls
    const runId = 'run_fake_1'
    port.evidence.add = async (params) => {
      _calls.push({ method: 'evidence.add', params })
      throw new Error('evidence.add failed: invalid kind')
    }

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
