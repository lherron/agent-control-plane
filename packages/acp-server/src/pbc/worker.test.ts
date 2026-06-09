/**
 * Red tests for src/pbc/worker.ts (Phase 4b — T-02773)
 *
 * Module under test: src/pbc/worker.ts (NOT YET IMPLEMENTED — all tests RED)
 *
 * ─── CONTRACT ─────────────────────────────────────────────────────────────────
 *
 *   runPbcContinuationWorker(port, input): Promise<PbcContinuationWorkerResult>
 *
 *   Worker loop (spec lines 846-866):
 *     1. Re-read wrkf.next. Stop if terminal, waiting-for-human (no simulation),
 *        ambiguous/blocked, SoD-blocked, or maxTurns exceeded.
 *     2. Ask pbcWorkerPolicy → 'stop' | 'continue'.
 *        ('write-output' is NOT used here; the worker always runs HRC.)
 *     3. Start wrkf run idempotently (run.start).
 *     4. Call port.launchAcpRun → acpRunId.
 *     5. Call port.getFinalAssistantText(acpRunId) → raw text.
 *        Fail the wrkf run if no text before worker timeout.
 *     6. Parse final text via parsePbcParticipantOutput.
 *     7. captureAndIngest via captures.get idempotency guard BEFORE evidence.add.
 *     8. run.finish after ingest succeeds; run.fail if ingest throws.
 *     9. Re-read wrkf.next; choose ONE safe PBC transition (freshness guard included).
 *    10. Deliver pending effects.
 *    11. Loop until stopped or maxTurns.
 *
 *   Invariants:
 *   - disposition transitions (dispose_from_*) are NEVER applied.
 *   - Human gates (clarification, patch_decision) STOP the worker.
 *   - Freshness guard (5a) gates finalize/pressure transitions.
 *   - Capture replay: existing evidence IDs returned, evidence.add NOT re-called.
 *   - Effect delivery is idempotent (effect.list driven; no double deliver).
 *
 * ─── FAKE PORT PATTERN ────────────────────────────────────────────────────────
 * Same _calls spy pattern as pbc-harness.test.ts.
 * getFinalAssistantText is injectable — no live HRC required.
 */

import { describe, expect, test } from 'bun:test'

// These imports define the module contract. They will fail until the module exists.
import {
  type PbcContinuationWorkerInput,
  type PbcContinuationWorkerPort,
  type PbcContinuationWorkerResult,
  runPbcContinuationWorker,
} from './worker.js'

// ---------------------------------------------------------------------------
// Minimal type aliases used in the fake port
// ---------------------------------------------------------------------------

type SpyCall = { method: string; params: unknown }

type FakeWorkerPort = PbcContinuationWorkerPort & { _calls: SpyCall[] }

// ---------------------------------------------------------------------------
// Helpers — raw next response builder
// ---------------------------------------------------------------------------

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
      state: { status: opts.status ?? 'active', phase: opts.phase ?? 'behavior_note' },
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

function makeEvidenceRecord(
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

// ---------------------------------------------------------------------------
// Fake port factory
// ---------------------------------------------------------------------------

/**
 * Build a fake PbcContinuationWorkerPort with _calls spy.
 *
 * opts.nextSequence        — successive next() calls return these in order. Repeats last.
 * opts.finalText           — text returned by getFinalAssistantText (all calls)
 * opts.finalTextByRunId    — per-acpRunId text override (takes precedence over finalText)
 * opts.effects             — pending effects returned by effect.list
 * opts.evidence            — timeline returned by evidence.list
 * opts.captureStore        — pre-populated capture records (for crash/replay tests)
 * opts.transitionShouldThrow — hook to simulate crash at transition.apply
 * opts.launchRunIdSequence — successive acpRunIds returned by launchAcpRun. Repeats last.
 */
function makeFakeWorkerPort(
  opts: {
    nextSequence?: Array<Record<string, unknown>>
    finalText?: string | undefined
    finalTextByRunId?: Record<string, string | undefined>
    effects?: Array<{ id: string; kind: string; status: string }>
    evidence?: Array<Record<string, unknown>>
    captureStore?: Record<string, unknown>
    transitionShouldThrow?: (transition: string) => Error | undefined
    launchRunIdSequence?: string[]
  } = {}
): FakeWorkerPort {
  const _calls: SpyCall[] = []
  const nextSeq = opts.nextSequence ?? [makeNextRaw({ status: 'closed', phase: 'finalized', actions: [] })]
  let nextCallIdx = 0
  const pendingEffects = opts.effects ?? []
  const evidenceTimeline: Record<string, unknown>[] = [...(opts.evidence ?? [])]
  const captureStore: Record<string, unknown> = { ...(opts.captureStore ?? {}) }
  const transitionThrow = opts.transitionShouldThrow ?? (() => undefined)
  const launchRunIds = opts.launchRunIdSequence ?? ['acp_run_fake_1']
  let launchCallIdx = 0
  let runCounter = 0
  let evidenceCounter = 0

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
        const record = makeEvidenceRecord(`ev_fake_${evidenceCounter}`, params.kind, {
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
        return []
      },
      satisfy: async (params: { task: string; id: string; evidenceId?: string }) => {
        _calls.push({ method: 'obligation.satisfy', params })
        return makeObligationRecord(params.id, 'unknown', 'satisfied')
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
        return makeRunRecord(`wrkf_run_fake_${runCounter}`)
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
      }) => {
        _calls.push({ method: 'transition.apply', params })
        const err = transitionThrow(params.transition)
        if (err !== undefined) {
          throw err
        }
        return {
          transition: params.transition,
          revision: (params.expectRevision ?? 0) + 1,
          status: 'applied',
          raw: {},
        }
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

    launchAcpRun: async (params: {
      taskId: string
      role: string
      actor: string
      idempotencyKey: string
      prompt?: string
    }) => {
      _calls.push({ method: 'launchAcpRun', params })
      const acpRunId = launchRunIds[Math.min(launchCallIdx, launchRunIds.length - 1)]
      launchCallIdx++
      return { acpRunId: acpRunId ?? 'acp_run_default' }
    },

    getFinalAssistantText: (acpRunId: string): string | undefined => {
      _calls.push({ method: 'getFinalAssistantText', params: { acpRunId } })
      if (opts.finalTextByRunId !== undefined && acpRunId in opts.finalTextByRunId) {
        return opts.finalTextByRunId[acpRunId]
      }
      return opts.finalText
    },
  }
}

// ---------------------------------------------------------------------------
// Standard ParticipantOutput JSON builders for fake HRC text
// ---------------------------------------------------------------------------

function behaviorNoteText(opts: { clarificationNeeded?: boolean } = {}): string {
  return JSON.stringify({
    evidence: [
      { kind: 'behavior_note', summary: 'user double-clicks the save button' },
      {
        kind: 'pre_interview_analysis',
        facts: { clarification_needed: opts.clarificationNeeded ?? false },
      },
    ],
  })
}

function pbcDraftText(): string {
  return JSON.stringify({
    evidence: [
      { kind: 'pbc_draft', summary: 'draft PBC output', data: { basedOnBehaviorNoteId: 'ev_1' } },
    ],
  })
}

function pressurePassText(draftEvidenceId: string): string {
  return JSON.stringify({
    evidence: [
      {
        kind: 'pressure_pass',
        facts: { verdict: 'ready' },
        data: { reviewedDraftEvidenceId: draftEvidenceId },
      },
    ],
  })
}

function pressurePassTooVagueText(draftEvidenceId: string): string {
  return JSON.stringify({
    evidence: [
      {
        kind: 'pressure_pass',
        facts: { verdict: 'too_vague' },
        data: { reviewedDraftEvidenceId: draftEvidenceId },
      },
    ],
  })
}

function pbcFinalText(draftId: string, pressureId: string): string {
  return JSON.stringify({
    evidence: [
      {
        kind: 'pbc_final',
        summary: 'final PBC output',
        data: { basedOnDraftEvidenceId: draftId, basedOnPressurePassEvidenceId: pressureId },
      },
    ],
  })
}

// ---------------------------------------------------------------------------
// Evidence timeline helper (for freshness guard tests)
// ---------------------------------------------------------------------------

function freshDraftTimeline(): Record<string, unknown>[] {
  return [makeEvidenceRecord('ev_draft_1', 'pbc_draft')]
}

function freshDraftAndPressureTimeline(): Record<string, unknown>[] {
  return [
    makeEvidenceRecord('ev_draft_1', 'pbc_draft'),
    makeEvidenceRecord('ev_pp_1', 'pressure_pass', {
      facts: { verdict: 'ready' },
      data: { reviewedDraftEvidenceId: 'ev_draft_1' },
    }),
  ]
}

// ===========================================================================
// 1. BEHAVIOR NOTE PHASE
// ===========================================================================

describe('runPbcContinuationWorker — behavior_note phase', () => {
  // ── basic: applies draft_pbc when clarification not needed ─────────────────

  test('behavior_note → evidence ingested → draft_pbc transition applied', async () => {
    const port = makeFakeWorkerPort({
      finalText: behaviorNoteText({ clarificationNeeded: false }),
      nextSequence: [
        // iteration 1 start
        makeNextRaw({
          status: 'active',
          phase: 'behavior_note',
          revision: 1,
          contextHash: 'sha256:ctx1',
          actions: [{ transition: 'draft_pbc' }],
        }),
        // after evidence write (fresh next before transition)
        makeNextRaw({
          status: 'active',
          phase: 'behavior_note',
          revision: 2,
          contextHash: 'sha256:ctx2',
          actions: [{ transition: 'draft_pbc' }],
        }),
        // post-transition: closed → stops loop
        makeNextRaw({ status: 'closed', phase: 'finalized', revision: 3, actions: [] }),
      ],
    })

    const result: PbcContinuationWorkerResult = await runPbcContinuationWorker(port, {
      taskId: 'T-00001',
      idempotencyKey: 'worker-bn-1',
      actor: 'agent:pbc-writer',
    } satisfies PbcContinuationWorkerInput)

    // Transition draft_pbc must have been applied
    const applyCall = port._calls.find(
      (c) =>
        c.method === 'transition.apply' &&
        (c.params as Record<string, unknown>)['transition'] === 'draft_pbc'
    )
    expect(applyCall).toBeDefined()
    expect(result.turnsCompleted).toBeGreaterThanOrEqual(1)
  })

  test('behavior_note: evidence.add called for behavior_note AND pre_interview_analysis', async () => {
    const port = makeFakeWorkerPort({
      finalText: behaviorNoteText({ clarificationNeeded: false }),
      nextSequence: [
        makeNextRaw({
          status: 'active',
          phase: 'behavior_note',
          revision: 1,
          actions: [{ transition: 'draft_pbc' }],
        }),
        makeNextRaw({
          status: 'active',
          phase: 'behavior_note',
          revision: 2,
          actions: [{ transition: 'draft_pbc' }],
        }),
        makeNextRaw({ status: 'closed', phase: 'finalized', revision: 3, actions: [] }),
      ],
    })

    await runPbcContinuationWorker(port, {
      taskId: 'T-00001',
      idempotencyKey: 'worker-bn-evidence',
      actor: 'agent:pbc-writer',
    } satisfies PbcContinuationWorkerInput)

    const evidenceKinds = port._calls
      .filter((c) => c.method === 'evidence.add')
      .map((c) => (c.params as Record<string, unknown>)['kind'])

    expect(evidenceKinds).toContain('behavior_note')
    expect(evidenceKinds).toContain('pre_interview_analysis')
  })

  test('behavior_note: run.finish called AFTER evidence ingestion', async () => {
    const port = makeFakeWorkerPort({
      finalText: behaviorNoteText({ clarificationNeeded: false }),
      nextSequence: [
        makeNextRaw({
          status: 'active',
          phase: 'behavior_note',
          revision: 1,
          actions: [{ transition: 'draft_pbc' }],
        }),
        makeNextRaw({
          status: 'active',
          phase: 'behavior_note',
          revision: 2,
          actions: [{ transition: 'draft_pbc' }],
        }),
        makeNextRaw({ status: 'closed', phase: 'finalized', revision: 3, actions: [] }),
      ],
    })

    await runPbcContinuationWorker(port, {
      taskId: 'T-00001',
      idempotencyKey: 'worker-bn-finish-order',
      actor: 'agent:pbc-writer',
    } satisfies PbcContinuationWorkerInput)

    const methods = port._calls.map((c) => c.method)
    const evidenceIdx = methods.indexOf('evidence.add')
    const finishIdx = methods.indexOf('run.finish')

    expect(evidenceIdx).toBeGreaterThan(-1)
    expect(finishIdx).toBeGreaterThan(evidenceIdx)
  })

  test('behavior_note: transition uses fresh contextHash from re-read next (not stale)', async () => {
    const port = makeFakeWorkerPort({
      finalText: behaviorNoteText({ clarificationNeeded: false }),
      nextSequence: [
        makeNextRaw({
          status: 'active',
          phase: 'behavior_note',
          revision: 1,
          contextHash: 'sha256:stale',
          actions: [{ transition: 'draft_pbc' }],
        }),
        // re-read after evidence write: fresh contextHash
        makeNextRaw({
          status: 'active',
          phase: 'behavior_note',
          revision: 2,
          contextHash: 'sha256:fresh',
          actions: [{ transition: 'draft_pbc' }],
        }),
        makeNextRaw({ status: 'closed', phase: 'finalized', revision: 3, actions: [] }),
      ],
    })

    await runPbcContinuationWorker(port, {
      taskId: 'T-00001',
      idempotencyKey: 'worker-bn-cas',
      actor: 'agent:pbc-writer',
    } satisfies PbcContinuationWorkerInput)

    const applyCall = port._calls.find((c) => c.method === 'transition.apply')
    expect(applyCall).toBeDefined()
    const params = applyCall!.params as Record<string, unknown>
    expect(params['contextHash']).toBe('sha256:fresh')
    expect(params['expectRevision']).toBe(2)
  })

  // ── stops at ask_clarification when clarification needed ───────────────────

  test('behavior_note → ask_clarification applied → stops with requires_product_owner_clarification', async () => {
    const port = makeFakeWorkerPort({
      // Only ask_clarification available (clarification_needed path)
      finalText: JSON.stringify({
        evidence: [
          { kind: 'behavior_note', summary: 'ambiguous behavior' },
        ],
      }),
      nextSequence: [
        // behavior_note: only ask_clarification available
        makeNextRaw({
          status: 'active',
          phase: 'behavior_note',
          revision: 1,
          actions: [{ transition: 'ask_clarification' }],
        }),
        // re-read after evidence write
        makeNextRaw({
          status: 'active',
          phase: 'behavior_note',
          revision: 2,
          actions: [{ transition: 'ask_clarification' }],
        }),
        // after ask_clarification transition: waiting/clarification
        makeNextRaw({
          status: 'waiting',
          phase: 'clarification',
          revision: 3,
          actions: [],
          openObligations: [{ id: 'obl_c1', kind: 'clarification_response', status: 'open' }],
        }),
      ],
    })

    const result = await runPbcContinuationWorker(port, {
      taskId: 'T-00001',
      idempotencyKey: 'worker-bn-clarif',
      actor: 'agent:pbc-writer',
    } satisfies PbcContinuationWorkerInput)

    // Worker must stop at clarification gate, not proceed further
    expect(result.stopReason).toBe('requires_product_owner_clarification')

    // ask_clarification was applied before stopping
    const applyCall = port._calls.find(
      (c) =>
        c.method === 'transition.apply' &&
        (c.params as Record<string, unknown>)['transition'] === 'ask_clarification'
    )
    expect(applyCall).toBeDefined()
  })

  // ── HRC launch and text recovery called ───────────────────────────────────

  test('behavior_note: launchAcpRun and getFinalAssistantText are called per turn', async () => {
    const port = makeFakeWorkerPort({
      finalText: behaviorNoteText({ clarificationNeeded: false }),
      nextSequence: [
        makeNextRaw({
          status: 'active',
          phase: 'behavior_note',
          revision: 1,
          actions: [{ transition: 'draft_pbc' }],
        }),
        makeNextRaw({
          status: 'active',
          phase: 'behavior_note',
          revision: 2,
          actions: [{ transition: 'draft_pbc' }],
        }),
        makeNextRaw({ status: 'closed', phase: 'finalized', revision: 3, actions: [] }),
      ],
    })

    await runPbcContinuationWorker(port, {
      taskId: 'T-00001',
      idempotencyKey: 'worker-bn-launch',
      actor: 'agent:pbc-writer',
    } satisfies PbcContinuationWorkerInput)

    expect(port._calls.some((c) => c.method === 'launchAcpRun')).toBe(true)
    expect(port._calls.some((c) => c.method === 'getFinalAssistantText')).toBe(true)
  })

  // ── run.start called before evidence ingest ────────────────────────────────

  test('run.start is called before evidence ingest in each turn', async () => {
    const port = makeFakeWorkerPort({
      finalText: behaviorNoteText({ clarificationNeeded: false }),
      nextSequence: [
        makeNextRaw({
          status: 'active',
          phase: 'behavior_note',
          revision: 1,
          actions: [{ transition: 'draft_pbc' }],
        }),
        makeNextRaw({
          status: 'active',
          phase: 'behavior_note',
          revision: 2,
          actions: [{ transition: 'draft_pbc' }],
        }),
        makeNextRaw({ status: 'closed', phase: 'finalized', revision: 3, actions: [] }),
      ],
    })

    await runPbcContinuationWorker(port, {
      taskId: 'T-00001',
      idempotencyKey: 'worker-bn-run-order',
      actor: 'agent:pbc-writer',
    } satisfies PbcContinuationWorkerInput)

    const methods = port._calls.map((c) => c.method)
    const runStartIdx = methods.indexOf('run.start')
    const evidenceIdx = methods.indexOf('evidence.add')

    expect(runStartIdx).toBeGreaterThan(-1)
    expect(evidenceIdx).toBeGreaterThan(runStartIdx)
  })

  // ── stopReason closed ──────────────────────────────────────────────────────

  test('returns stopReason=closed when instance transitions to closed status', async () => {
    const port = makeFakeWorkerPort({
      finalText: behaviorNoteText({ clarificationNeeded: false }),
      nextSequence: [
        makeNextRaw({
          status: 'active',
          phase: 'behavior_note',
          revision: 1,
          actions: [{ transition: 'draft_pbc' }],
        }),
        makeNextRaw({
          status: 'active',
          phase: 'behavior_note',
          revision: 2,
          actions: [{ transition: 'draft_pbc' }],
        }),
        makeNextRaw({ status: 'closed', phase: 'finalized', revision: 3, actions: [] }),
      ],
    })

    const result = await runPbcContinuationWorker(port, {
      taskId: 'T-00001',
      idempotencyKey: 'worker-bn-closed',
      actor: 'agent:pbc-writer',
    } satisfies PbcContinuationWorkerInput)

    expect(result.stopReason).toBe('closed')
    expect(result.finalStatus).toBe('succeeded')
  })

  // ── stops immediately on already-closed instance ───────────────────────────

  test('stops immediately (no run.start) when instance is already closed', async () => {
    const port = makeFakeWorkerPort({
      nextSequence: [
        makeNextRaw({ status: 'closed', phase: 'finalized', revision: 5, actions: [] }),
      ],
    })

    const result = await runPbcContinuationWorker(port, {
      taskId: 'T-00001',
      idempotencyKey: 'worker-pre-closed',
      actor: 'agent:pbc-writer',
    } satisfies PbcContinuationWorkerInput)

    expect(result.stopReason).toBe('closed')
    expect(port._calls.find((c) => c.method === 'run.start')).toBeUndefined()
    expect(port._calls.find((c) => c.method === 'launchAcpRun')).toBeUndefined()
  })

  // ── stale flag is diagnostics-only ────────────────────────────────────────

  test('ignores next.instance.stale and attempts participant work', async () => {
    const port = makeFakeWorkerPort({
      finalText: behaviorNoteText(),
      nextSequence: [
        makeNextRaw({
          status: 'active',
          phase: 'behavior_note',
          revision: 2,
          stale: true,
          actions: [],
        }),
      ],
    })

    const result = await runPbcContinuationWorker(port, {
      taskId: 'T-00001',
      idempotencyKey: 'worker-stale',
      actor: 'agent:pbc-writer',
    } satisfies PbcContinuationWorkerInput)

    expect(result.stopReason).toBe('blocked_or_ambiguous')
    expect(result.turnsCompleted).toBe(1)
    expect(port._calls.find((c) => c.method === 'run.start')).toBeDefined()
    expect(port._calls.find((c) => c.method === 'launchAcpRun')).toBeDefined()
  })
})

// ===========================================================================
// 2. PRESSURE PHASE
// ===========================================================================

describe('runPbcContinuationWorker — pressure phase', () => {
  // ── pressure ready → pbc_final → finalize ─────────────────────────────────

  test('pressure/ready → pbc_final evidence → finalize_ready_pbc transition applied', async () => {
    // Evidence timeline already has fresh pbc_draft + pressure_pass (freshness passes)
    const port = makeFakeWorkerPort({
      // HRC writes pbc_final output in the pressure turn
      finalText: pbcFinalText('ev_draft_1', 'ev_pp_1'),
      evidence: freshDraftAndPressureTimeline(),
      nextSequence: [
        // pressure phase, finalize_ready_pbc available
        makeNextRaw({
          status: 'active',
          phase: 'pressure',
          revision: 5,
          contextHash: 'sha256:ctx5',
          actions: [{ transition: 'finalize_ready_pbc' }],
        }),
        // after evidence write
        makeNextRaw({
          status: 'active',
          phase: 'pressure',
          revision: 6,
          contextHash: 'sha256:ctx6',
          actions: [{ transition: 'finalize_ready_pbc' }],
        }),
        // post-finalize
        makeNextRaw({ status: 'closed', phase: 'finalized', revision: 7, actions: [] }),
      ],
    })

    const result = await runPbcContinuationWorker(port, {
      taskId: 'T-00001',
      idempotencyKey: 'worker-pressure-finalize',
      actor: 'agent:pbc-writer',
      pressureActor: 'agent:pressure-reviewer',
    } satisfies PbcContinuationWorkerInput)

    const applyCall = port._calls.find(
      (c) =>
        c.method === 'transition.apply' &&
        (c.params as Record<string, unknown>)['transition'] === 'finalize_ready_pbc'
    )
    expect(applyCall).toBeDefined()
    expect(result.stopReason).toBe('closed')
  })

  // ── pressure freshness guard blocks stale finalize ─────────────────────────

  test('finalize_ready_pbc blocked by freshness guard when evidence is stale', async () => {
    // No fresh draft in evidence timeline → freshness guard blocks finalize
    const port = makeFakeWorkerPort({
      finalText: pbcFinalText('ev_draft_old', 'ev_pp_old'),
      evidence: [], // empty timeline → no fresh draft → freshness blocked
      nextSequence: [
        makeNextRaw({
          status: 'active',
          phase: 'pressure',
          revision: 3,
          actions: [{ transition: 'finalize_ready_pbc' }],
        }),
        makeNextRaw({
          status: 'active',
          phase: 'pressure',
          revision: 4,
          actions: [{ transition: 'finalize_ready_pbc' }],
        }),
        // Still blocked
        makeNextRaw({ status: 'closed', phase: 'finalized', revision: 5, actions: [] }),
      ],
    })

    const result = await runPbcContinuationWorker(port, {
      taskId: 'T-00001',
      idempotencyKey: 'worker-pressure-stale',
      actor: 'agent:pbc-writer',
      pressureActor: 'agent:pressure-reviewer',
    } satisfies PbcContinuationWorkerInput)

    // finalize_ready_pbc must NOT have been applied (freshness blocked it)
    const finalizeApply = port._calls.find(
      (c) =>
        c.method === 'transition.apply' &&
        (c.params as Record<string, unknown>)['transition'] === 'finalize_ready_pbc'
    )
    expect(finalizeApply).toBeUndefined()
    // Worker should stop (blocked_or_ambiguous or similar)
    expect(result.stopReason).not.toBeUndefined()
  })

  // ── needs_patch → STOPS at patch_decision human gate ──────────────────────

  test('needs_patch → request_patch_decision applied → stops at patch_decision human gate', async () => {
    const port = makeFakeWorkerPort({
      finalText: pressurePassText('ev_draft_1'),
      evidence: freshDraftTimeline(),
      nextSequence: [
        // pressure: needs_patch path → request_patch_decision
        makeNextRaw({
          status: 'active',
          phase: 'pressure',
          revision: 3,
          actions: [{ transition: 'request_patch_decision' }],
        }),
        // after evidence write
        makeNextRaw({
          status: 'active',
          phase: 'pressure',
          revision: 4,
          actions: [{ transition: 'request_patch_decision' }],
        }),
        // after request_patch_decision applied: waiting/patch_decision
        makeNextRaw({
          status: 'waiting',
          phase: 'patch_decision',
          revision: 5,
          actions: [],
          openObligations: [{ id: 'obl_pd1', kind: 'patch_decision', status: 'open' }],
        }),
      ],
    })

    const result = await runPbcContinuationWorker(port, {
      taskId: 'T-00001',
      idempotencyKey: 'worker-needs-patch',
      actor: 'agent:pbc-writer',
      pressureActor: 'agent:pressure-reviewer',
    } satisfies PbcContinuationWorkerInput)

    // Worker MUST stop at patch_decision human gate
    expect(result.stopReason).toBe('requires_product_owner_patch_decision')

    // request_patch_decision was applied before stopping
    const applyCall = port._calls.find(
      (c) =>
        c.method === 'transition.apply' &&
        (c.params as Record<string, unknown>)['transition'] === 'request_patch_decision'
    )
    expect(applyCall).toBeDefined()
  })

  // ── too_vague → revise_too_vague_pbc → loops back ─────────────────────────

  test('too_vague → revise_too_vague_pbc applied → loops back to pbc_draft', async () => {
    const port = makeFakeWorkerPort({
      finalText: pressurePassTooVagueText('ev_draft_1'),
      evidence: freshDraftTimeline(),
      nextSequence: [
        // pressure: too_vague path → revise_too_vague_pbc
        makeNextRaw({
          status: 'active',
          phase: 'pressure',
          revision: 4,
          actions: [{ transition: 'revise_too_vague_pbc' }],
        }),
        // after evidence write
        makeNextRaw({
          status: 'active',
          phase: 'pressure',
          revision: 5,
          actions: [{ transition: 'revise_too_vague_pbc' }],
        }),
        // after revise transition: loops to pbc_draft
        makeNextRaw({
          status: 'active',
          phase: 'pbc_draft',
          revision: 6,
          actions: [{ transition: 'run_pressure_pass' }],
        }),
        // stop the loop to prevent infinite recursion in test
        makeNextRaw({ status: 'closed', phase: 'finalized', revision: 7, actions: [] }),
      ],
    })

    const result = await runPbcContinuationWorker(port, {
      taskId: 'T-00001',
      idempotencyKey: 'worker-too-vague',
      actor: 'agent:pbc-writer',
      pressureActor: 'agent:pressure-reviewer',
    } satisfies PbcContinuationWorkerInput)

    // revise_too_vague_pbc must have been applied
    const reviseApply = port._calls.find(
      (c) =>
        c.method === 'transition.apply' &&
        (c.params as Record<string, unknown>)['transition'] === 'revise_too_vague_pbc'
    )
    expect(reviseApply).toBeDefined()

    // Worker eventually stops (not infinite loop)
    expect(result.stopReason).toBeDefined()
  })

  // ── SoD: finalize requires distinct pressure reviewer ─────────────────────

  test('finalize blocked (not applied) when pressureActor same as actor (SoD violation)', async () => {
    const port = makeFakeWorkerPort({
      finalText: pbcFinalText('ev_draft_1', 'ev_pp_1'),
      evidence: freshDraftAndPressureTimeline(),
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
      ],
    })

    const result = await runPbcContinuationWorker(port, {
      taskId: 'T-00001',
      idempotencyKey: 'worker-sod',
      actor: 'agent:pbc-writer',
      pressureActor: 'agent:pbc-writer', // SAME as actor → SoD violation
    } satisfies PbcContinuationWorkerInput)

    // finalize_ready_pbc must NOT be applied (SoD)
    const finalizeApply = port._calls.find(
      (c) =>
        c.method === 'transition.apply' &&
        (c.params as Record<string, unknown>)['transition'] === 'finalize_ready_pbc'
    )
    expect(finalizeApply).toBeUndefined()
    expect(result.stopReason).toBe('requires_distinct_pressure_reviewer')
  })

  // ── Effects delivered after finalize ──────────────────────────────────────

  test('effects delivered after finalize_ready_pbc transition', async () => {
    const port = makeFakeWorkerPort({
      finalText: pbcFinalText('ev_draft_1', 'ev_pp_1'),
      evidence: freshDraftAndPressureTimeline(),
      effects: [{ id: 'eff_finalize_1', kind: 'set_task_state', status: 'pending' }],
      nextSequence: [
        makeNextRaw({
          status: 'active',
          phase: 'pressure',
          revision: 5,
          actions: [{ transition: 'finalize_ready_pbc' }],
        }),
        makeNextRaw({
          status: 'active',
          phase: 'pressure',
          revision: 6,
          actions: [{ transition: 'finalize_ready_pbc' }],
        }),
        makeNextRaw({ status: 'closed', phase: 'finalized', revision: 7, actions: [] }),
      ],
    })

    await runPbcContinuationWorker(port, {
      taskId: 'T-00001',
      idempotencyKey: 'worker-finalize-effects',
      actor: 'agent:pbc-writer',
      pressureActor: 'agent:pressure-reviewer',
    } satisfies PbcContinuationWorkerInput)

    const methods = port._calls.map((c) => c.method)
    const transitionIdx = methods.indexOf('transition.apply')
    const effectListIdx = methods.indexOf('effect.list')
    const effectDeliverIdx = methods.indexOf('effect.deliver')

    expect(transitionIdx).toBeGreaterThan(-1)
    expect(effectListIdx).toBeGreaterThan(transitionIdx)
    expect(effectDeliverIdx).toBeGreaterThan(effectListIdx)
    expect((port._calls.find((c) => c.method === 'effect.deliver')!.params as Record<string, unknown>)['effectId']).toBe('eff_finalize_1')
  })
})

// ===========================================================================
// 3. CRASH / REPLAY — evidence capture idempotency
// ===========================================================================

describe('runPbcContinuationWorker — crash/replay', () => {
  // ── crash after evidence write before transition → no duplicate evidence ───

  test('crash after evidence write: replay returns existing evidence IDs, no duplicate evidence.add', async () => {
    // Pre-populate captures as if first run wrote evidence before crash
    const existingEvidenceId = 'ev_existing_bn_1'
    const captureKey = 'worker-crash-replay:participant-output:T-00001'
    const preSeededCapture = {
      status: 'ingested',
      evidenceAdded: [{ id: existingEvidenceId, kind: 'behavior_note', raw: {} }],
      obligationsSatisfied: [],
    }

    const port = makeFakeWorkerPort({
      captureStore: { [captureKey]: preSeededCapture },
      finalText: behaviorNoteText({ clarificationNeeded: false }),
      nextSequence: [
        // Crash happened after evidence was written at revision 2, before transition
        makeNextRaw({
          status: 'active',
          phase: 'behavior_note',
          revision: 2,
          contextHash: 'sha256:ctx2',
          actions: [{ transition: 'draft_pbc' }],
        }),
        // re-read after capture replay (same revision, transition still legal)
        makeNextRaw({
          status: 'active',
          phase: 'behavior_note',
          revision: 2,
          contextHash: 'sha256:ctx2',
          actions: [{ transition: 'draft_pbc' }],
        }),
        // post-transition
        makeNextRaw({ status: 'closed', phase: 'finalized', revision: 3, actions: [] }),
      ],
    })

    await runPbcContinuationWorker(port, {
      taskId: 'T-00001',
      idempotencyKey: 'worker-crash-replay',
      actor: 'agent:pbc-writer',
    } satisfies PbcContinuationWorkerInput)

    // evidence.add must NOT be called again (replay)
    const evidenceAddCalls = port._calls.filter((c) => c.method === 'evidence.add')
    expect(evidenceAddCalls).toHaveLength(0)

    // captures.get must be called (checking idempotency store)
    const captureGetCalls = port._calls.filter((c) => c.method === 'captures.get')
    expect(captureGetCalls.length).toBeGreaterThan(0)
  })

  test('crash after evidence write: transition still applied (replay does not skip transition)', async () => {
    const existingEvidenceId = 'ev_existing_bn_1'
    const captureKey = 'worker-crash-trans:participant-output:T-00001'
    const preSeededCapture = {
      status: 'ingested',
      evidenceAdded: [{ id: existingEvidenceId, kind: 'behavior_note', raw: {} }],
      obligationsSatisfied: [],
    }

    const port = makeFakeWorkerPort({
      captureStore: { [captureKey]: preSeededCapture },
      finalText: behaviorNoteText({ clarificationNeeded: false }),
      nextSequence: [
        makeNextRaw({
          status: 'active',
          phase: 'behavior_note',
          revision: 2,
          contextHash: 'sha256:ctx2',
          actions: [{ transition: 'draft_pbc' }],
        }),
        makeNextRaw({
          status: 'active',
          phase: 'behavior_note',
          revision: 2,
          contextHash: 'sha256:ctx2',
          actions: [{ transition: 'draft_pbc' }],
        }),
        makeNextRaw({ status: 'closed', phase: 'finalized', revision: 3, actions: [] }),
      ],
    })

    await runPbcContinuationWorker(port, {
      taskId: 'T-00001',
      idempotencyKey: 'worker-crash-trans',
      actor: 'agent:pbc-writer',
    } satisfies PbcContinuationWorkerInput)

    // Transition must still be applied on replay
    const applyCall = port._calls.find((c) => c.method === 'transition.apply')
    expect(applyCall).toBeDefined()
    expect((applyCall!.params as Record<string, unknown>)['transition']).toBe('draft_pbc')
  })

  // ── first run: captures.set called after successful evidence ingest ─────────

  test('successful ingest: captures.set called with ingested evidence IDs', async () => {
    const captureStore: Record<string, unknown> = {}

    const port = makeFakeWorkerPort({
      captureStore,
      finalText: behaviorNoteText({ clarificationNeeded: false }),
      nextSequence: [
        makeNextRaw({
          status: 'active',
          phase: 'behavior_note',
          revision: 1,
          actions: [{ transition: 'draft_pbc' }],
        }),
        makeNextRaw({
          status: 'active',
          phase: 'behavior_note',
          revision: 2,
          actions: [{ transition: 'draft_pbc' }],
        }),
        makeNextRaw({ status: 'closed', phase: 'finalized', revision: 3, actions: [] }),
      ],
    })

    await runPbcContinuationWorker(port, {
      taskId: 'T-00001',
      idempotencyKey: 'worker-capture-set',
      actor: 'agent:pbc-writer',
    } satisfies PbcContinuationWorkerInput)

    // captures.set must be called after successful ingest
    const setCalls = port._calls.filter((c) => c.method === 'captures.set')
    expect(setCalls.length).toBeGreaterThan(0)

    // The capture record must include evidence IDs
    const setCall = setCalls[0]!
    const record = (setCall.params as Record<string, unknown>)['record'] as Record<string, unknown>
    expect(record['status']).toBe('ingested')
    expect(Array.isArray(record['evidenceAdded'])).toBe(true)
  })

  // ── crash after transition before effects → effect delivery replay ─────────

  test('effect delivery replay: effects delivered idempotently (only pending effects)', async () => {
    // Simulate crash after transition: first "run" already applied transition;
    // second "run" sees effects as still pending and delivers them
    // The key invariant: effect.deliver called exactly once per pending effect in
    // a single worker invocation (no double delivery within one run).
    const port = makeFakeWorkerPort({
      finalText: behaviorNoteText({ clarificationNeeded: false }),
      effects: [
        { id: 'eff_replay_1', kind: 'set_task_state', status: 'pending' },
        { id: 'eff_replay_2', kind: 'set_task_state', status: 'pending' },
      ],
      nextSequence: [
        makeNextRaw({
          status: 'active',
          phase: 'behavior_note',
          revision: 1,
          actions: [{ transition: 'draft_pbc' }],
        }),
        makeNextRaw({
          status: 'active',
          phase: 'behavior_note',
          revision: 2,
          actions: [{ transition: 'draft_pbc' }],
        }),
        makeNextRaw({ status: 'closed', phase: 'finalized', revision: 3, actions: [] }),
      ],
    })

    await runPbcContinuationWorker(port, {
      taskId: 'T-00001',
      idempotencyKey: 'worker-eff-replay',
      actor: 'agent:pbc-writer',
    } satisfies PbcContinuationWorkerInput)

    const deliverCalls = port._calls.filter((c) => c.method === 'effect.deliver')
    const deliveredIds = deliverCalls.map(
      (c) => (c.params as Record<string, unknown>)['effectId']
    )

    // Each pending effect delivered exactly once
    expect(deliveredIds.filter((id) => id === 'eff_replay_1')).toHaveLength(1)
    expect(deliveredIds.filter((id) => id === 'eff_replay_2')).toHaveLength(1)
  })

  test('no effect.deliver called if effect.list returns empty (already delivered)', async () => {
    // Simulates crash after all effects delivered: effect.list returns empty
    const port = makeFakeWorkerPort({
      finalText: behaviorNoteText({ clarificationNeeded: false }),
      effects: [], // empty → already delivered
      nextSequence: [
        makeNextRaw({
          status: 'active',
          phase: 'behavior_note',
          revision: 1,
          actions: [{ transition: 'draft_pbc' }],
        }),
        makeNextRaw({
          status: 'active',
          phase: 'behavior_note',
          revision: 2,
          actions: [{ transition: 'draft_pbc' }],
        }),
        makeNextRaw({ status: 'closed', phase: 'finalized', revision: 3, actions: [] }),
      ],
    })

    await runPbcContinuationWorker(port, {
      taskId: 'T-00001',
      idempotencyKey: 'worker-no-eff-deliver',
      actor: 'agent:pbc-writer',
    } satisfies PbcContinuationWorkerInput)

    const deliverCalls = port._calls.filter((c) => c.method === 'effect.deliver')
    expect(deliverCalls).toHaveLength(0)
  })

  // ── run.fail on HRC text missing ───────────────────────────────────────────

  test('run.fail called and worker stops when getFinalAssistantText returns undefined', async () => {
    const port = makeFakeWorkerPort({
      finalText: undefined, // no text → worker fails the run
      nextSequence: [
        makeNextRaw({
          status: 'active',
          phase: 'behavior_note',
          revision: 1,
          actions: [{ transition: 'draft_pbc' }],
        }),
      ],
    })

    const result = await runPbcContinuationWorker(port, {
      taskId: 'T-00001',
      idempotencyKey: 'worker-no-text',
      actor: 'agent:pbc-writer',
    } satisfies PbcContinuationWorkerInput)

    // run.fail must be called (open run must not be orphaned)
    const failCall = port._calls.find((c) => c.method === 'run.fail')
    expect(failCall).toBeDefined()

    // run.finish must NOT be called
    const finishCall = port._calls.find((c) => c.method === 'run.finish')
    expect(finishCall).toBeUndefined()

    // Worker reports failed status
    expect(result.finalStatus).toBe('failed')
  })
})

// ===========================================================================
// 4. DISPOSITION NEVER SELECTED BY WORKER
// ===========================================================================

describe('runPbcContinuationWorker — disposition gate', () => {
  test('dispose_from_behavior_note is NEVER applied by the worker', async () => {
    const port = makeFakeWorkerPort({
      finalText: behaviorNoteText({ clarificationNeeded: false }),
      nextSequence: [
        // Only disposition available
        makeNextRaw({
          status: 'active',
          phase: 'behavior_note',
          revision: 1,
          actions: [{ transition: 'dispose_from_behavior_note' }],
        }),
        makeNextRaw({
          status: 'active',
          phase: 'behavior_note',
          revision: 2,
          actions: [{ transition: 'dispose_from_behavior_note' }],
        }),
      ],
    })

    const result = await runPbcContinuationWorker(port, {
      taskId: 'T-00001',
      idempotencyKey: 'worker-no-dispose',
      actor: 'agent:pbc-writer',
      maxTurns: 1,
    } satisfies PbcContinuationWorkerInput)

    // disposition must never be applied
    const dispositionApply = port._calls.find(
      (c) =>
        c.method === 'transition.apply' &&
        String((c.params as Record<string, unknown>)['transition']).startsWith('dispose_from_')
    )
    expect(dispositionApply).toBeUndefined()
    // Worker stops without applying disposition
    expect(result.stopReason).toBeDefined()
  })

  test('dispose_from_pbc_draft is NEVER applied by the worker', async () => {
    const port = makeFakeWorkerPort({
      finalText: pbcDraftText(),
      evidence: freshDraftTimeline(),
      nextSequence: [
        makeNextRaw({
          status: 'active',
          phase: 'pbc_draft',
          revision: 3,
          actions: [{ transition: 'dispose_from_pbc_draft' }],
        }),
        makeNextRaw({
          status: 'active',
          phase: 'pbc_draft',
          revision: 4,
          actions: [{ transition: 'dispose_from_pbc_draft' }],
        }),
      ],
    })

    const result = await runPbcContinuationWorker(port, {
      taskId: 'T-00001',
      idempotencyKey: 'worker-no-dispose-pbc',
      actor: 'agent:pbc-writer',
      maxTurns: 1,
    } satisfies PbcContinuationWorkerInput)

    const dispositionApply = port._calls.find(
      (c) =>
        c.method === 'transition.apply' &&
        String((c.params as Record<string, unknown>)['transition']).startsWith('dispose_from_')
    )
    expect(dispositionApply).toBeUndefined()
    expect(result.stopReason).toBeDefined()
  })

  test('dispose_from_pressure is NEVER applied by the worker', async () => {
    const port = makeFakeWorkerPort({
      finalText: pressurePassText('ev_draft_1'),
      evidence: freshDraftTimeline(),
      nextSequence: [
        makeNextRaw({
          status: 'active',
          phase: 'pressure',
          revision: 5,
          actions: [{ transition: 'dispose_from_pressure' }],
        }),
        makeNextRaw({
          status: 'active',
          phase: 'pressure',
          revision: 6,
          actions: [{ transition: 'dispose_from_pressure' }],
        }),
      ],
    })

    const result = await runPbcContinuationWorker(port, {
      taskId: 'T-00001',
      idempotencyKey: 'worker-no-dispose-pressure',
      actor: 'agent:pbc-writer',
      pressureActor: 'agent:pressure-reviewer',
      maxTurns: 1,
    } satisfies PbcContinuationWorkerInput)

    const dispositionApply = port._calls.find(
      (c) =>
        c.method === 'transition.apply' &&
        String((c.params as Record<string, unknown>)['transition']).startsWith('dispose_from_')
    )
    expect(dispositionApply).toBeUndefined()
    expect(result.stopReason).toBeDefined()
  })
})

// ===========================================================================
// 5. maxTurns guard
// ===========================================================================

describe('runPbcContinuationWorker — maxTurns', () => {
  test('stops at maxTurns with max_turns stop reason', async () => {
    // Always return an actionable state so worker doesn't stop for other reasons
    const alwaysNext = makeNextRaw({
      status: 'active',
      phase: 'behavior_note',
      revision: 1,
      actions: [{ transition: 'draft_pbc' }],
    })

    const port = makeFakeWorkerPort({
      finalText: behaviorNoteText({ clarificationNeeded: false }),
      nextSequence: Array.from({ length: 20 }, () => alwaysNext),
    })

    const result = await runPbcContinuationWorker(port, {
      taskId: 'T-00001',
      idempotencyKey: 'worker-maxturn',
      actor: 'agent:pbc-writer',
      maxTurns: 2,
    } satisfies PbcContinuationWorkerInput)

    expect(result.stopReason).toBe('max_turns')
    expect(result.turnsCompleted).toBeLessThanOrEqual(2)
  })
})

// ===========================================================================
// 6. Result model
// ===========================================================================

describe('runPbcContinuationWorker — result model', () => {
  test('result.taskId matches input.taskId', async () => {
    const port = makeFakeWorkerPort({
      nextSequence: [makeNextRaw({ status: 'closed', phase: 'finalized', actions: [] })],
    })

    const result = await runPbcContinuationWorker(port, {
      taskId: 'T-99999',
      idempotencyKey: 'worker-task-id',
      actor: 'agent:pbc-writer',
    } satisfies PbcContinuationWorkerInput)

    expect(result.taskId).toBe('T-99999')
  })

  test('result.turnsCompleted is 0 when stopped immediately (closed)', async () => {
    const port = makeFakeWorkerPort({
      nextSequence: [makeNextRaw({ status: 'closed', phase: 'finalized', revision: 5, actions: [] })],
    })

    const result = await runPbcContinuationWorker(port, {
      taskId: 'T-00001',
      idempotencyKey: 'worker-turns-zero',
      actor: 'agent:pbc-writer',
    } satisfies PbcContinuationWorkerInput)

    expect(result.turnsCompleted).toBe(0)
  })

  test('result.finalRevision reflects the last wrkf.next revision read', async () => {
    const port = makeFakeWorkerPort({
      finalText: behaviorNoteText({ clarificationNeeded: false }),
      nextSequence: [
        makeNextRaw({
          status: 'active',
          phase: 'behavior_note',
          revision: 3,
          actions: [{ transition: 'draft_pbc' }],
        }),
        makeNextRaw({
          status: 'active',
          phase: 'behavior_note',
          revision: 4,
          actions: [{ transition: 'draft_pbc' }],
        }),
        makeNextRaw({ status: 'closed', phase: 'finalized', revision: 5, actions: [] }),
      ],
    })

    const result = await runPbcContinuationWorker(port, {
      taskId: 'T-00001',
      idempotencyKey: 'worker-final-rev',
      actor: 'agent:pbc-writer',
    } satisfies PbcContinuationWorkerInput)

    // Must reflect the latest revision seen
    expect(result.finalRevision).toBeGreaterThanOrEqual(4)
  })

  test('result.stopReason is always present', async () => {
    const port = makeFakeWorkerPort({
      nextSequence: [makeNextRaw({ status: 'closed', phase: 'finalized', actions: [] })],
    })

    const result = await runPbcContinuationWorker(port, {
      taskId: 'T-00001',
      idempotencyKey: 'worker-stopr',
      actor: 'agent:pbc-writer',
    } satisfies PbcContinuationWorkerInput)

    expect(typeof result.stopReason).toBe('string')
    expect(result.stopReason!.length).toBeGreaterThan(0)
  })

  test('result.finalStatus is succeeded when instance closes normally', async () => {
    const port = makeFakeWorkerPort({
      finalText: behaviorNoteText({ clarificationNeeded: false }),
      nextSequence: [
        makeNextRaw({
          status: 'active',
          phase: 'behavior_note',
          revision: 1,
          actions: [{ transition: 'draft_pbc' }],
        }),
        makeNextRaw({
          status: 'active',
          phase: 'behavior_note',
          revision: 2,
          actions: [{ transition: 'draft_pbc' }],
        }),
        makeNextRaw({ status: 'closed', phase: 'finalized', revision: 3, actions: [] }),
      ],
    })

    const result = await runPbcContinuationWorker(port, {
      taskId: 'T-00001',
      idempotencyKey: 'worker-final-ok',
      actor: 'agent:pbc-writer',
    } satisfies PbcContinuationWorkerInput)

    expect(result.finalStatus).toBe('succeeded')
  })
})

// ===========================================================================
// 7. PbcContinuationWorkerPort type contract
// ===========================================================================

describe('PbcContinuationWorkerPort type contract', () => {
  test('makeFakeWorkerPort satisfies PbcContinuationWorkerPort structural type', () => {
    // Type-only assertion: compile failure = red (structural mismatch)
    const port: PbcContinuationWorkerPort = makeFakeWorkerPort() as unknown as PbcContinuationWorkerPort
    expect(port).toBeDefined()
  })
})
