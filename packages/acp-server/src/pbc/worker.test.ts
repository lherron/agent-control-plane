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
 * opts.finalTextSequence   — successive texts returned by getFinalAssistantText. Repeats last.
 *                            Takes precedence over finalText and finalTextByRunId.
 * opts.effects             — pending effects returned by effect.list
 * opts.evidence            — timeline returned by evidence.list
 * opts.captureStore        — pre-populated capture records (for crash/replay tests)
 * opts.transitionShouldThrow — hook to simulate crash at transition.apply
 * opts.launchRunIdSequence — successive acpRunIds returned by launchAcpRun. Repeats last.
 * opts.includeJobs         — include jobs.acquireLease / jobs.transition / jobs.renewLease spy
 *                            in the returned port (default false to preserve existing test compat)
 */
function makeFakeWorkerPort(
  opts: {
    nextSequence?: Array<Record<string, unknown>>
    finalText?: string | undefined
    finalTextByRunId?: Record<string, string | undefined>
    finalTextSequence?: Array<string | undefined>
    effects?: Array<{ id: string; kind: string; status: string }>
    evidence?: Array<Record<string, unknown>>
    captureStore?: Record<string, unknown>
    transitionShouldThrow?: (transition: string) => Error | undefined
    launchRunIdSequence?: string[]
    includeJobs?: boolean
    obligationsForList?: Array<{ id: string; kind: string; status: string }>
    runStatus?: string
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
        return (opts.obligationsForList ?? []).map((o) => makeObligationRecord(o.id, o.kind, o.status))
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
      // Determine result BEFORE pushing to _calls (so call-count-based indexing is correct)
      let result: string | undefined
      if (opts.finalTextSequence !== undefined) {
        const callCount = _calls.filter((c) => c.method === 'getFinalAssistantText').length
        const seq = opts.finalTextSequence
        result = callCount < seq.length ? seq[callCount] : seq[seq.length - 1]
      } else if (opts.finalTextByRunId !== undefined && acpRunId in opts.finalTextByRunId) {
        result = opts.finalTextByRunId[acpRunId]
      } else {
        result = opts.finalText
      }
      _calls.push({ method: 'getFinalAssistantText', params: { acpRunId } })
      return result
    },

    ...(opts.runStatus !== undefined
      ? {
          getRunStatus: (acpRunId: string): string | undefined => {
            _calls.push({ method: 'getRunStatus', params: { acpRunId } })
            return opts.runStatus
          },
        }
      : {}),

    ...(opts.includeJobs === true
      ? {
          jobs: {
            acquireLease: async (params: {
              jobId: string
              leaseOwner: string
              leaseExpiresAt: string
            }) => {
              _calls.push({ method: 'jobs.acquireLease', params })
              return { acquired: true, job: { jobId: params.jobId } }
            },
            transition: async (params: {
              jobId: string
              toStatus: 'succeeded' | 'failed' | 'cancelled'
              resultJson?: unknown
              errorJson?: unknown
              stopReason?: string
            }) => {
              _calls.push({ method: 'jobs.transition', params })
              return { jobId: params.jobId, status: params.toStatus }
            },
            renewLease: async (params: {
              jobId: string
              leaseOwner: string
              leaseExpiresAt: string
            }) => {
              _calls.push({ method: 'jobs.renewLease', params })
              return { jobId: params.jobId }
            },
          },
        }
      : {}),
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

  test('behavior_note: worker does NOT call evidence.add (the agent records directly); launches the turn and applies draft_pbc', async () => {
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

    // The worker no longer ingests evidence — the agent records it directly.
    expect(port._calls.filter((c) => c.method === 'evidence.add')).toHaveLength(0)
    // The worker launches the participant turn ...
    expect(port._calls.some((c) => c.method === 'launchAcpRun')).toBe(true)
    // ... and applies the draft_pbc transition.
    const applyCall = port._calls.find(
      (c) =>
        c.method === 'transition.apply' &&
        (c.params as Record<string, unknown>)['transition'] === 'draft_pbc'
    )
    expect(applyCall).toBeDefined()
  })

  test('run.finish (status completed) is called after the turn and before transition.apply', async () => {
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

    const launchIdx = port._calls.findIndex((c) => c.method === 'launchAcpRun')
    const finishIdx = port._calls.findIndex((c) => c.method === 'run.finish')
    const transitionIdx = port._calls.findIndex((c) => c.method === 'transition.apply')

    expect(launchIdx).toBeGreaterThan(-1)
    expect(finishIdx).toBeGreaterThan(launchIdx)
    expect(transitionIdx).toBeGreaterThan(finishIdx)

    const finishCall = port._calls.find((c) => c.method === 'run.finish')!
    expect((finishCall.params as Record<string, unknown>)['status']).toBe('completed')
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

  test('run.start is called before launchAcpRun in each turn', async () => {
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

    const runStartIdx = port._calls.findIndex((c) => c.method === 'run.start')
    const launchIdx = port._calls.findIndex((c) => c.method === 'launchAcpRun')

    expect(runStartIdx).toBeGreaterThan(-1)
    expect(launchIdx).toBeGreaterThan(runStartIdx)
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
    // The phase has no candidate transition, so choosePbcTransition stays blocked
    // and the worker re-launches the same phase up to the retry budget before
    // giving up — at least one turn completed.
    expect(result.turnsCompleted).toBeGreaterThanOrEqual(1)
    expect(port._calls.find((c) => c.method === 'run.start')).toBeDefined()
    expect(port._calls.find((c) => c.method === 'launchAcpRun')).toBeDefined()
  })

  // ── retry: a turn that leaves the phase incomplete is re-launched (T-03775) ─

  test('retries the same phase when the first turn leaves no legal transition, then advances', async () => {
    const port = makeFakeWorkerPort({
      finalText: behaviorNoteText(),
      nextSequence: [
        // iter1 start — behavior_note, rev 1, no transition yet
        makeNextRaw({ status: 'active', phase: 'behavior_note', revision: 1, actions: [] }),
        // iter1 post-turn — still no legal transition → blocked → RETRY
        makeNextRaw({ status: 'active', phase: 'behavior_note', revision: 1, actions: [] }),
        // iter2 (retry) start — same revision
        makeNextRaw({ status: 'active', phase: 'behavior_note', revision: 1, actions: [] }),
        // iter2 post-turn — the (retried) agent recorded evidence → transition now legal
        makeNextRaw({
          status: 'active',
          phase: 'behavior_note',
          revision: 1,
          actions: [{ transition: 'draft_pbc' }],
        }),
        // after transition + next iter start — closed → stop
        makeNextRaw({ status: 'closed', phase: 'finalized', actions: [] }),
      ],
    })

    const result = await runPbcContinuationWorker(port, {
      taskId: 'T-00001',
      idempotencyKey: 'worker-retry',
      actor: 'agent:pbc-writer',
    } satisfies PbcContinuationWorkerInput)

    // Two launches: the first (blocked) and the retry that advanced.
    const launches = port._calls.filter((c) => c.method === 'launchAcpRun')
    expect(launches.length).toBe(2)
    // The retry launch carries a distinct :retry: idempotency suffix so a NEW HRC
    // turn actually runs (same key would resume the prior run — the T-03775 bug).
    expect(String(launches[0]?.params['idempotencyKey'])).not.toContain(':retry:')
    expect(String(launches[1]?.params['idempotencyKey'])).toContain(':retry:1')
    // The phase advanced on the retry.
    const transitions = port._calls.filter((c) => c.method === 'transition.apply')
    expect(transitions.length).toBe(1)
    expect(transitions[0]?.params['transition']).toBe('draft_pbc')
    expect(result.finalStatus).toBe('succeeded')
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
    // Finalization is applied by the reviewer actor under its bound wrkf role —
    // role=agent + reviewer actor is rejected by wrkf's role-binding gate (T-03778).
    expect((applyCall?.params as Record<string, unknown>)['role']).toBe('pressure_reviewer')
    expect((applyCall?.params as Record<string, unknown>)['actor']).toBe('agent:pressure-reviewer')
    expect(result.stopReason).toBe('closed')
  })

  test('empty final text + terminal HRC run → turn counts as complete, finalize applied (T-04024)', async () => {
    // The participant recorded evidence via direct wrkf calls but ended its turn
    // with an empty assistant message. The HRC run is COMPLETED, so the worker
    // must not wait for text that will never arrive.
    const port = makeFakeWorkerPort({
      finalText: '',
      runStatus: 'completed',
      evidence: freshDraftAndPressureTimeline(),
      nextSequence: [
        makeNextRaw({
          status: 'active',
          phase: 'pressure',
          revision: 5,
          contextHash: 'sha256:ctx5',
          actions: [{ transition: 'finalize_ready_pbc' }],
        }),
        makeNextRaw({
          status: 'active',
          phase: 'pressure',
          revision: 5,
          contextHash: 'sha256:ctx5',
          actions: [{ transition: 'finalize_ready_pbc' }],
        }),
        makeNextRaw({ status: 'closed', phase: 'finalized', revision: 6, actions: [] }),
      ],
    })

    const result = await runPbcContinuationWorker(port, {
      taskId: 'T-00001',
      idempotencyKey: 'worker-empty-text-terminal',
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
    expect(result.turnsCompleted).toBeGreaterThanOrEqual(1)
  })

  test('thrown error after a completed turn reports the real turnsCompleted, not 0', async () => {
    const port = makeFakeWorkerPort({
      finalText: pbcFinalText('ev_draft_1', 'ev_pp_1'),
      evidence: freshDraftAndPressureTimeline(),
      nextSequence: [
        makeNextRaw({
          status: 'active',
          phase: 'pressure',
          revision: 5,
          contextHash: 'sha256:ctx5',
          actions: [{ transition: 'finalize_ready_pbc' }],
        }),
        makeNextRaw({
          status: 'active',
          phase: 'pressure',
          revision: 6,
          contextHash: 'sha256:ctx6',
          actions: [{ transition: 'finalize_ready_pbc' }],
        }),
      ],
      transitionShouldThrow: (transition) =>
        transition === 'finalize_ready_pbc' ? new Error('wrkf rejected transition') : undefined,
    })

    const result = await runPbcContinuationWorker(port, {
      taskId: 'T-00001',
      idempotencyKey: 'worker-turns-not-masked',
      actor: 'agent:pbc-writer',
      pressureActor: 'agent:pressure-reviewer',
    } satisfies PbcContinuationWorkerInput)

    expect(result.finalStatus).toBe('failed')
    expect(result.stopReason).toContain('wrkf rejected transition')
    // The pressure turn DID complete before the transition blew up; the
    // result must not mask that as zero turns (T-03778 secondary finding).
    expect(result.turnsCompleted).toBe(1)
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

  // ── first missing HRC text awaits participant output ───────────────────────

  test('run.fail is not called on first missing getFinalAssistantText while participant turn is live', async () => {
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

    // run.fail must NOT be called: the participant turn may still be running.
    const failCall = port._calls.find((c) => c.method === 'run.fail')
    expect(failCall).toBeUndefined()

    // run.finish must NOT be called
    const finishCall = port._calls.find((c) => c.method === 'run.finish')
    expect(finishCall).toBeUndefined()

    // Worker reports non-terminal await status. Timeout tests cover eventual run.fail.
    expect(result.stopReason).toBe('awaiting_participant_output')
    expect(result.finalStatus).not.toBe('failed')
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

// ===========================================================================
// 8. RESUMABLE AWAITING — RED tests for T-03527
//
// These tests are RED against the current implementation (worker.ts lines 196-200)
// which immediately calls run.fail + returns 'missing_final_assistant_text' when
// getFinalAssistantText returns empty — regardless of whether the participant turn
// has had time to complete.
//
// The correct (post-fix) behaviour is:
//  • Within the max-wait window: keep the job alive, renew the lease, return
//    stopReason='awaiting_participant_output' (non-terminal).
//  • On a subsequent tick where text IS available: process normally (idempotent launch).
//  • After max-wait exceeded: fail with 'missing_final_assistant_text'.
//
// DECISION comment (C-03853): resumable / non-blocking approach.
// ===========================================================================

describe('runPbcContinuationWorker — awaiting: empty text within wait window (T-03527 behavior 1)', () => {
  // ── Core: non-terminal result when text not yet available ──────────────────

  test('empty getFinalAssistantText → stopReason awaiting_participant_output, not failed', async () => {
    const port = makeFakeWorkerPort({
      finalText: undefined,
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
      idempotencyKey: 'worker-await-01',
      actor: 'agent:pbc-writer',
    })

    // Must return non-terminal "still waiting" result
    expect(result.stopReason).toBe('awaiting_participant_output')
    expect(result.finalStatus).not.toBe('failed')
  })

  test('empty getFinalAssistantText → evidence.add NOT called', async () => {
    const port = makeFakeWorkerPort({
      finalText: undefined,
      nextSequence: [
        makeNextRaw({
          status: 'active',
          phase: 'behavior_note',
          revision: 1,
          actions: [{ transition: 'draft_pbc' }],
        }),
      ],
    })

    await runPbcContinuationWorker(port, {
      taskId: 'T-00001',
      idempotencyKey: 'worker-await-02',
      actor: 'agent:pbc-writer',
    })

    expect(port._calls.some((c) => c.method === 'evidence.add')).toBe(false)
  })

  test('empty getFinalAssistantText → transition.apply NOT called', async () => {
    const port = makeFakeWorkerPort({
      finalText: undefined,
      nextSequence: [
        makeNextRaw({
          status: 'active',
          phase: 'behavior_note',
          revision: 1,
          actions: [{ transition: 'draft_pbc' }],
        }),
      ],
    })

    await runPbcContinuationWorker(port, {
      taskId: 'T-00001',
      idempotencyKey: 'worker-await-03',
      actor: 'agent:pbc-writer',
    })

    expect(port._calls.some((c) => c.method === 'transition.apply')).toBe(false)
  })

  test('empty getFinalAssistantText → run.fail NOT called (participant turn is still live)', async () => {
    const port = makeFakeWorkerPort({
      finalText: undefined,
      nextSequence: [
        makeNextRaw({
          status: 'active',
          phase: 'behavior_note',
          revision: 1,
          actions: [{ transition: 'draft_pbc' }],
        }),
      ],
    })

    await runPbcContinuationWorker(port, {
      taskId: 'T-00001',
      idempotencyKey: 'worker-await-04',
      actor: 'agent:pbc-writer',
    })

    // run.fail must NOT be called: the participant (larry) is still running
    expect(port._calls.some((c) => c.method === 'run.fail')).toBe(false)
  })

  // ── Job lease: renewed when awaiting, NOT transitioned to terminal ─────────

  test('awaiting: jobs.renewLease called and jobs.transition NOT called (job stays alive)', async () => {
    const port = makeFakeWorkerPort({
      finalText: undefined,
      includeJobs: true,
      nextSequence: [
        makeNextRaw({
          status: 'active',
          phase: 'behavior_note',
          revision: 1,
          actions: [{ transition: 'draft_pbc' }],
        }),
      ],
    })

    await runPbcContinuationWorker(port, {
      taskId: 'T-00001',
      idempotencyKey: 'worker-await-05',
      actor: 'agent:pbc-writer',
      jobId: 'job_await_test',
      leaseOwner: 'test-scheduler',
    })

    // Lease must be renewed (not failed): job stays alive so the next tick can re-check
    expect(port._calls.some((c) => c.method === 'jobs.renewLease')).toBe(true)
    // Must NOT transition job to a terminal status
    const terminalTransition = port._calls.find(
      (c) =>
        c.method === 'jobs.transition' &&
        ['succeeded', 'failed', 'cancelled'].includes(
          String((c.params as Record<string, unknown>)['toStatus'])
        )
    )
    expect(terminalTransition).toBeUndefined()
  })
})

describe('runPbcContinuationWorker — resume: subsequent invocation with text (T-03527 behavior 2)', () => {
  // ── Resume: first invocation awaits; second invocation processes normally ──

  test('resume: first invocation returns awaiting; second invocation (text now available) applies transition', async () => {
    // getFinalAssistantText: first call → undefined, subsequent calls → text
    const port = makeFakeWorkerPort({
      finalTextSequence: [undefined, behaviorNoteText(), behaviorNoteText()],
      // Same acpRunId returned both times (idempotent launch)
      launchRunIdSequence: ['acp_run_resume_1', 'acp_run_resume_1'],
      nextSequence: [
        // First invocation reads this
        makeNextRaw({
          status: 'active',
          phase: 'behavior_note',
          revision: 1,
          actions: [{ transition: 'draft_pbc' }],
        }),
        // Second invocation + post-evidence re-read
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

    const input: PbcContinuationWorkerInput = {
      taskId: 'T-00001',
      idempotencyKey: 'worker-resume-01',
      actor: 'agent:pbc-writer',
    }

    // First invocation: participant output not yet available
    const result1 = await runPbcContinuationWorker(port, input)
    // RED: current code returns 'missing_final_assistant_text' + finalStatus='failed'
    expect(result1.stopReason).toBe('awaiting_participant_output')
    expect(result1.finalStatus).not.toBe('failed')

    // Second invocation: text now available — must process normally
    const result2 = await runPbcContinuationWorker(port, input)
    expect(result2.finalStatus).toBe('succeeded')

    // Transition must be applied on the second invocation
    expect(port._calls.some((c) => c.method === 'transition.apply')).toBe(true)
  })

  test('resume: launchAcpRun called with the SAME idempotency key on both invocations (idempotent, no new turn)', async () => {
    const port = makeFakeWorkerPort({
      finalTextSequence: [undefined, behaviorNoteText()],
      launchRunIdSequence: ['acp_run_resume_2', 'acp_run_resume_2'],
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

    const input: PbcContinuationWorkerInput = {
      taskId: 'T-00001',
      idempotencyKey: 'worker-resume-02',
      actor: 'agent:pbc-writer',
    }

    // Two invocations with the same input
    await runPbcContinuationWorker(port, input)
    await runPbcContinuationWorker(port, input)

    // All launchAcpRun calls must use the SAME idempotency key
    // (idempotent on :launch:revision — no new turn started on resume)
    const launchCalls = port._calls.filter((c) => c.method === 'launchAcpRun')
    expect(launchCalls.length).toBeGreaterThanOrEqual(1)
    const launchKeys = launchCalls.map(
      (c) => (c.params as Record<string, unknown>)['idempotencyKey']
    )
    const uniqueKeys = new Set(launchKeys)
    expect(uniqueKeys.size).toBe(1) // all calls share the same idempotency key
  })
})

describe('runPbcContinuationWorker — timeout: max-wait exceeded (T-03527 behavior 3)', () => {
  // ── Timeout: after max-wait, fails with missing_final_assistant_text ───────
  //
  // The worker must track WHEN it started waiting (via captures) and compare
  // against the configured timeout. Pre-seeding captures with a timestamp far
  // in the past simulates the "already waited too long" scenario.
  //
  // The RED assertion below: captures.get must be called for an elapsed-time
  // tracking key (contains 'wait' / 'await' / 'elapsed' / 'since').
  // Current code never checks captures when text is undefined — it fails immediately.

  test('timeout exceeded → fails with missing_final_assistant_text AND elapsed time was checked via captures', async () => {
    // Pre-seed captures to simulate that output-wait began 10 minutes ago
    const TEN_MINUTES_AGO = new Date(Date.now() - 10 * 60 * 1000).toISOString()
    const captureStore: Record<string, unknown> = {
      // Cover plausible key shapes the implementation might use:
      'worker-timeout-01:output-wait-started-at:1': TEN_MINUTES_AGO,
      'worker-timeout-01:output-wait-start:1': TEN_MINUTES_AGO,
      'worker-timeout-01:awaiting-since:1': TEN_MINUTES_AGO,
      'worker-timeout-01:participant-wait-start:1': TEN_MINUTES_AGO,
    }

    const port = makeFakeWorkerPort({
      finalText: undefined,
      captureStore,
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
      idempotencyKey: 'worker-timeout-01',
      actor: 'agent:pbc-writer',
    })

    // Timeout path: fails with the canonical missing-text error
    expect(result.stopReason).toBe('missing_final_assistant_text')
    expect(result.finalStatus).toBe('failed')

    // RED assertion: the implementation MUST check captures for elapsed time
    // (so it can distinguish "within window" from "timeout exceeded").
    // Current code never calls captures.get when text is undefined.
    const captureGetCalls = port._calls.filter((c) => c.method === 'captures.get')
    const elapsedKeyCall = captureGetCalls.find((c) => {
      const key = String((c.params as Record<string, unknown>)['captureKey'] ?? '')
      return (
        key.includes('wait') ||
        key.includes('await') ||
        key.includes('elapsed') ||
        key.includes('since')
      )
    })
    expect(elapsedKeyCall).toBeDefined()
  })

  test('timeout: run.fail IS called when timeout exceeded (open run must be cleaned up)', async () => {
    const TEN_MINUTES_AGO = new Date(Date.now() - 10 * 60 * 1000).toISOString()
    const captureStore: Record<string, unknown> = {
      'worker-timeout-02:output-wait-started-at:1': TEN_MINUTES_AGO,
      'worker-timeout-02:output-wait-start:1': TEN_MINUTES_AGO,
      'worker-timeout-02:awaiting-since:1': TEN_MINUTES_AGO,
      'worker-timeout-02:participant-wait-start:1': TEN_MINUTES_AGO,
    }

    const port = makeFakeWorkerPort({
      finalText: undefined,
      captureStore,
      nextSequence: [
        makeNextRaw({
          status: 'active',
          phase: 'behavior_note',
          revision: 1,
          actions: [{ transition: 'draft_pbc' }],
        }),
      ],
    })

    await runPbcContinuationWorker(port, {
      taskId: 'T-00001',
      idempotencyKey: 'worker-timeout-02',
      actor: 'agent:pbc-writer',
    })

    // On timeout (not on every awaiting tick), run.fail must be called
    expect(port._calls.some((c) => c.method === 'run.fail')).toBe(true)
    // run.finish must NOT be called (the run did not succeed)
    expect(port._calls.some((c) => c.method === 'run.finish')).toBe(false)
  })
})

// ===========================================================================
// 10. WORKER PROMPT CONTENT (T-03678)
//
// RED tests: compileWorkerPrompt / tryCompileTemplatePrompt must embed the
// task's actual product feedback and prior-evidence CONTENT in the compiled
// prompt so the agent can produce grounded PBC evidence — not content-blind
// output about the prompt contract itself.
//
// Current behavior (RED): compilePbcPrompt renders prior evidence as a
// summary-only list ("- intake_metadata (id: ev_1)"). The rawFeedback string,
// behavior_note content, clarification_response answer, and pbc_draft content
// are NOT included. The agent literally cannot see the product feedback.
//
// Expected behavior (post-fix): the compiled prompt includes a CONTEXT section
// with the actual content of relevant prior evidence so the agent writes PBC
// evidence grounded in the real feedback (e.g. "dark mode toggle").
// ===========================================================================

/**
 * Minimal valid PBC template embedded on next.instance.template so
 * tryCompileTemplatePrompt takes the template path (not the fallback).
 */
const PROMPT_CONTENT_TEMPLATE: Record<string, unknown> = {
  nextActionModel: {
    schemaVersion: 'wrkf.next-action-model.v1',
    scope: { allowedKinds: [] },
    promptCatalog: {},
    roles: {
      agent: {
        hardRules: ['Ground all evidence in the actual task context.'],
      },
      pressure_reviewer: {
        hardRules: ['Review the pbc_draft for quality and fidelity to the product feedback.'],
      },
    },
    phaseGuidance: {
      'active/behavior_note': {
        agentInstruction:
          'Produce behavior_note and pre_interview_analysis based on the product feedback.',
        expectedEvidence: ['behavior_note', 'pre_interview_analysis'],
        blockedBy: [],
        avoid: [],
      },
      'active/pbc_draft': {
        agentInstruction:
          'Draft the PBC grounded in the behavior note and clarification response.',
        expectedEvidence: ['pbc_draft'],
        blockedBy: [],
        avoid: [],
      },
      'active/pressure': {
        agentInstruction:
          'Review the pbc_draft and produce pressure_pass evidence.',
        expectedEvidence: ['pressure_pass', 'pbc_final when ready'],
        blockedBy: [],
        avoid: [],
      },
    },
    transitionGuidance: {
      draft_pbc: {
        prompt: 'Propose draft_pbc after producing behavior_note.',
        produceEvidence: ['behavior_note'],
        satisfyObligations: [],
      },
      run_pressure_pass: {
        prompt: 'Propose run_pressure_pass after completing the draft.',
        produceEvidence: ['pbc_draft'],
        satisfyObligations: [],
      },
      finalize_ready_pbc: {
        prompt: 'Propose finalize_ready_pbc when pressure_pass verdict is ready.',
        produceEvidence: ['pbc_final'],
        satisfyObligations: [],
      },
    },
  },
}

/**
 * Build a raw next response for a given phase with PROMPT_CONTENT_TEMPLATE
 * embedded on instance.template so tryCompileTemplatePrompt takes the
 * template path rather than falling back to the bare prompt.
 */
function makeNextRawWithTemplate(opts: {
  phase: string
  revision?: number
  actions?: Array<{ transition: string; role?: string }>
}): Record<string, unknown> {
  const base = makeNextRaw({
    status: 'active',
    phase: opts.phase,
    revision: opts.revision ?? 1,
    actions: opts.actions ?? [],
  })
  // Inject template onto instance so tryCompileTemplatePrompt is exercised
  ;(base['instance'] as Record<string, unknown>)['template'] = PROMPT_CONTENT_TEMPLATE
  return base
}

/**
 * Extract the prompt string passed to launchAcpRun from the call spy.
 * Returns undefined when launchAcpRun was never called.
 */
function extractLaunchPrompt(port: FakeWorkerPort): string | undefined {
  const call = port._calls.find((c) => c.method === 'launchAcpRun')
  if (call === undefined) return undefined
  return (call.params as Record<string, unknown>)['prompt'] as string | undefined
}

describe('runPbcContinuationWorker — worker prompt content (T-03678)', () => {
  // ── Test 1 (RED): behavior_note phase — prompt must contain rawFeedback ─────
  //
  // The pbc-writer's pre_interview_analysis asked "what is the actual product
  // feedback?" because the prompt did not include the intake rawFeedback.
  // After the fix, rawFeedback must appear verbatim in the compiled prompt.

  test('behavior_note: compiled prompt contains intake_metadata rawFeedback string from priorEvidence [RED]', async () => {
    const RAW_FEEDBACK = 'dark mode toggle is missing from the settings page'

    const port = makeFakeWorkerPort({
      // finalText undefined → awaiting path; launchAcpRun still fires first
      finalText: undefined,
      evidence: [
        makeEvidenceRecord('ev_intake_1', 'intake_metadata', {
          facts: { rawFeedback: RAW_FEEDBACK },
        }),
      ],
      nextSequence: [
        makeNextRawWithTemplate({
          phase: 'behavior_note',
          revision: 1,
          actions: [{ transition: 'draft_pbc' }],
        }),
      ],
    })

    await runPbcContinuationWorker(port, {
      taskId: 'T-03678-bn',
      idempotencyKey: 'prompt-content-bn-01',
      actor: 'agent:pbc-writer',
    })

    const prompt = extractLaunchPrompt(port)
    expect(prompt).toBeDefined()
    // RED: current compilePbcPrompt renders "- intake_metadata (id: ev_intake_1)"
    // — the rawFeedback string is NOT included anywhere in the prompt.
    expect(prompt).toContain(RAW_FEEDBACK)
  })

  // ── Test 2 (RED): pbc_draft phase — prompt must contain behavior_note + clarif content

  test('pbc_draft: compiled prompt contains behavior_note content and clarification_response answer from priorEvidence [RED]', async () => {
    const BN_CONTENT = 'User expects a dark-mode toggle in Settings > Display.'
    const CLARIF_ANSWER = 'Settings > Display > Theme — add a dark/light toggle control.'

    const port = makeFakeWorkerPort({
      finalText: undefined,
      evidence: [
        makeEvidenceRecord('ev_intake_1', 'intake_metadata', {
          facts: { rawFeedback: 'dark mode toggle is missing' },
        }),
        makeEvidenceRecord('ev_bn_1', 'behavior_note', {
          facts: { content: BN_CONTENT },
        }),
        makeEvidenceRecord('ev_cr_1', 'clarification_response', {
          facts: { answer: CLARIF_ANSWER },
        }),
      ],
      nextSequence: [
        makeNextRawWithTemplate({
          phase: 'pbc_draft',
          revision: 3,
          actions: [{ transition: 'run_pressure_pass' }],
        }),
      ],
    })

    await runPbcContinuationWorker(port, {
      taskId: 'T-03678-draft',
      idempotencyKey: 'prompt-content-draft-01',
      actor: 'agent:pbc-writer',
    })

    const prompt = extractLaunchPrompt(port)
    expect(prompt).toBeDefined()
    // RED: current compilePbcPrompt only lists "- behavior_note (id: ev_bn_1)"
    // — neither facts.content nor clarification_response facts.answer is included.
    expect(prompt).toContain(BN_CONTENT)
    expect(prompt).toContain(CLARIF_ANSWER)
  })

  // ── Test 3 (RED): pressure phase — prompt must contain current pbc_draft content

  test('pressure: compiled prompt contains pbc_draft facts.content from priorEvidence [RED]', async () => {
    const DRAFT_CONTENT =
      'When the user navigates to Settings > Display, they see a dark mode toggle that persists across sessions.'

    const port = makeFakeWorkerPort({
      finalText: undefined,
      evidence: [
        makeEvidenceRecord('ev_bn_1', 'behavior_note', {
          facts: { content: 'User expects dark mode toggle in Settings.' },
        }),
        makeEvidenceRecord('ev_draft_1', 'pbc_draft', {
          facts: { content: DRAFT_CONTENT, iteration: 1 },
        }),
      ],
      nextSequence: [
        makeNextRawWithTemplate({
          phase: 'pressure',
          revision: 5,
          // explicit pressure_reviewer role so participantFor returns pressure_reviewer
          actions: [{ transition: 'finalize_ready_pbc', role: 'pressure_reviewer' }],
        }),
      ],
    })

    await runPbcContinuationWorker(port, {
      taskId: 'T-03678-pressure',
      idempotencyKey: 'prompt-content-pressure-01',
      actor: 'agent:pbc-writer',
      // distinct pressureActor so the SoD check in pbcWorkerPolicy passes
      pressureActor: 'agent:pbc-reviewer',
    })

    const prompt = extractLaunchPrompt(port)
    expect(prompt).toBeDefined()
    // RED: current compilePbcPrompt only lists "- pbc_draft (id: ev_draft_1)"
    // — the draft text (facts.content) is NOT embedded in the prompt.
    expect(prompt).toContain(DRAFT_CONTENT)
  })

  // ── Test 4 (GREEN): strict-JSON directive + per-phase schema always present ──
  //
  // These are already appended by compileWorkerPrompt / compilePbcPrompt today.
  // This test MUST STAY GREEN through the fix and serve as a regression guard.

  test('compiled prompt instructs the wrkf evidence loop, not a JSON-emit contract', async () => {
    const port = makeFakeWorkerPort({
      finalText: undefined,
      evidence: [],
      nextSequence: [
        makeNextRawWithTemplate({
          phase: 'behavior_note',
          revision: 1,
          actions: [{ transition: 'draft_pbc' }],
        }),
      ],
    })

    await runPbcContinuationWorker(port, {
      taskId: 'T-03678-schema',
      idempotencyKey: 'prompt-content-schema-01',
      actor: 'agent:pbc-writer',
    })

    const prompt = extractLaunchPrompt(port)
    expect(prompt).toBeDefined()
    // The agent records evidence by driving the wrkf CLI directly.
    expect(prompt).toContain('wrkf evidence add')
    expect(prompt).toContain('wrkf next')
    expect(prompt).toContain('Do NOT run `wrkf transition`')
    // The old strict-JSON-emit contract is gone.
    expect(prompt).not.toContain('## Output contract — STRICT')
    expect(prompt).not.toContain('ParticipantOutput')
  })
})

// ===========================================================================
// 11. WORKER PROMPT CONTENT — FALLBACK PATH (T-03755)
//
// RED tests: compileWorkerPrompt FALLBACK (triggered when next.instance.template
// is absent — the live production case) must ALSO embed the CONTEXT section with
// raw product feedback and per-phase prior-evidence content.
//
// Root cause: T-03678 added the CONTEXT section only inside compilePbcPrompt
// (the template path). compileWorkerPrompt's fallback (worker.ts ~line 569) emits
// only Task/Role/Actor/Workflow-state + strict directive + schema — NO context.
// Live next has no template → fallback is used → agents write content-blind.
//
// These three tests force the FALLBACK path (next.instance.template is UNDEFINED)
// and assert content that the fallback currently omits. All three FAIL now.
// The existing T-03678 tests (template path) must remain GREEN through the fix.
// ===========================================================================

describe('runPbcContinuationWorker — worker prompt content FALLBACK path (T-03755)', () => {
  // ── Test 1 (RED): behavior_note phase, fallback → must contain rawFeedback ──────
  //
  // FAILS NOW: compileWorkerPrompt fallback omits the CONTEXT section entirely.
  // extractRawFeedback / PHASE_CONTEXT_KINDS are only applied in compilePbcPrompt
  // (template path). The fallback only emits Task/Role/Actor/Workflow-state header
  // + STRICT_OUTPUT_DIRECTIVE + PARTICIPANT_OUTPUT_SCHEMA.

  test('behavior_note fallback: compiled prompt contains intake_metadata rawFeedback string [RED]', async () => {
    const RAW_FEEDBACK = 'dark mode toggle is missing from the settings page'

    const port = makeFakeWorkerPort({
      // finalText undefined → awaiting_participant_output path; launchAcpRun still fires
      finalText: undefined,
      evidence: [
        makeEvidenceRecord('ev_intake_1', 'intake_metadata', {
          facts: { rawFeedback: RAW_FEEDBACK },
        }),
      ],
      nextSequence: [
        // NO template on instance → tryCompileTemplatePrompt returns undefined → fallback
        makeNextRaw({
          status: 'active',
          phase: 'behavior_note',
          revision: 1,
          actions: [{ transition: 'draft_pbc' }],
        }),
      ],
    })

    await runPbcContinuationWorker(port, {
      taskId: 'T-03755-bn',
      idempotencyKey: 'prompt-fallback-bn-01',
      actor: 'agent:pbc-writer',
    })

    const prompt = extractLaunchPrompt(port)
    expect(prompt).toBeDefined()
    // RED: fallback prompt has no context section — rawFeedback absent
    expect(prompt).toContain(RAW_FEEDBACK)
  })

  // ── Test 2 (RED): pbc_draft phase, fallback → must contain behavior_note + clarif content ──
  //
  // FAILS NOW: fallback emits no prior-evidence content. The pbc-writer needs
  // behavior_note content + clarification_response answer to draft a grounded PBC.

  test('pbc_draft fallback: compiled prompt contains behavior_note content and clarification_response answer [RED]', async () => {
    const BN_CONTENT = 'User expects a dark-mode toggle in Settings > Display.'
    const CLARIF_ANSWER = 'Settings > Display > Theme — add a dark/light toggle control.'

    const port = makeFakeWorkerPort({
      finalText: undefined,
      evidence: [
        makeEvidenceRecord('ev_intake_1', 'intake_metadata', {
          facts: { rawFeedback: 'dark mode toggle is missing' },
        }),
        makeEvidenceRecord('ev_bn_1', 'behavior_note', {
          facts: { content: BN_CONTENT },
        }),
        makeEvidenceRecord('ev_cr_1', 'clarification_response', {
          facts: { answer: CLARIF_ANSWER },
        }),
      ],
      nextSequence: [
        // NO template on instance → fallback path
        makeNextRaw({
          status: 'active',
          phase: 'pbc_draft',
          revision: 3,
          actions: [{ transition: 'run_pressure_pass' }],
        }),
      ],
    })

    await runPbcContinuationWorker(port, {
      taskId: 'T-03755-draft',
      idempotencyKey: 'prompt-fallback-draft-01',
      actor: 'agent:pbc-writer',
    })

    const prompt = extractLaunchPrompt(port)
    expect(prompt).toBeDefined()
    // RED: fallback prompt has no context — neither BN_CONTENT nor CLARIF_ANSWER present
    expect(prompt).toContain(BN_CONTENT)
    expect(prompt).toContain(CLARIF_ANSWER)
  })

  // ── Test 3 (RED): pressure phase, fallback → must contain pbc_draft content AND evidence id ──
  //
  // FAILS NOW: fallback omits all prior-evidence content. Both assertions are RED:
  // (a) pbc_draft content — reviewer can't evaluate what it can't see.
  // (b) pbc_draft evidence id — pbc-reviewer MUST copy this into
  //     reviewedDraftEvidenceId so the finalize gate can close.

  test('pressure fallback: compiled prompt contains pbc_draft content AND pbc_draft evidence id [RED]', async () => {
    const DRAFT_CONTENT =
      'When the user navigates to Settings > Display, they see a dark mode toggle that persists across sessions.'
    const DRAFT_EVIDENCE_ID = 'ev_draft_fallback_1'

    const port = makeFakeWorkerPort({
      finalText: undefined,
      evidence: [
        makeEvidenceRecord('ev_bn_1', 'behavior_note', {
          facts: { content: 'User expects dark mode toggle in Settings.' },
        }),
        makeEvidenceRecord(DRAFT_EVIDENCE_ID, 'pbc_draft', {
          facts: { content: DRAFT_CONTENT, iteration: 1 },
        }),
      ],
      nextSequence: [
        // NO template on instance → fallback path.
        // Use request_patch_decision (non-finalization) to avoid SoD stop check.
        makeNextRaw({
          status: 'active',
          phase: 'pressure',
          revision: 5,
          actions: [{ transition: 'request_patch_decision' }],
        }),
      ],
    })

    await runPbcContinuationWorker(port, {
      taskId: 'T-03755-pressure',
      idempotencyKey: 'prompt-fallback-pressure-01',
      actor: 'agent:pbc-writer',
      pressureActor: 'agent:pbc-reviewer',
    })

    const prompt = extractLaunchPrompt(port)
    expect(prompt).toBeDefined()
    // RED: fallback prompt has no context section — draft content absent
    expect(prompt).toContain(DRAFT_CONTENT)
    // RED: evidence id absent — reviewer cannot set reviewedDraftEvidenceId
    expect(prompt).toContain(DRAFT_EVIDENCE_ID)
  })
})
