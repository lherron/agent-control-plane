import { describe, expect, test } from 'bun:test'
import {
  behaviorNoteText,
  makeFakeWorkerPort,
  makeNextRaw,
} from '../../test/fixtures/pbc-worker.js'
import { type PbcContinuationWorkerInput, runPbcContinuationWorker } from './worker.js'

// Worker progression: Phase 4b, T-02773; original contract spec lines 846-866.
// Call-order and evidence replay pins remain in the completed-turn survivor.

// ===========================================================================
// 1. BEHAVIOR NOTE PHASE
// ===========================================================================

describe('runPbcContinuationWorker — behavior_note phase', () => {
  test('a completed behavior_note turn applies draft_pbc with the re-read revision and contextHash, then stops closed', async () => {
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

    const result = await runPbcContinuationWorker(port, {
      taskId: 'T-00001',
      idempotencyKey: 'worker-bn-cas',
      actor: 'agent:pbc-writer',
    } satisfies PbcContinuationWorkerInput)

    // One full turn, in order: start run → launch → bind → read text → finish run →
    // re-read next → apply → deliver effects → re-read until closed.
    expect(port._calls.map((c) => c.method)).toEqual([
      'next',
      'run.start',
      'evidence.list',
      'launchAcpRun',
      'run.bindExternal',
      'getFinalAssistantText',
      'run.finish',
      'next',
      'evidence.list',
      'transition.apply',
      'effect.list',
      'next',
      'next',
    ])
    // The worker no longer ingests evidence itself — the agent records it directly.
    expect(port._calls.filter((c) => c.method === 'evidence.add')).toHaveLength(0)
    expect(port._calls.find((c) => c.method === 'run.finish')?.params).toEqual({
      runId: 'wrkf_run_fake_1',
      status: 'completed',
    })
    const applyCall = port._calls.find((c) => c.method === 'transition.apply')
    expect(applyCall?.params).toMatchObject({
      transition: 'draft_pbc',
      contextHash: 'sha256:fresh',
      expectRevision: 2,
    })
    expect(result).toEqual({
      taskId: 'T-00001',
      turnsCompleted: 1,
      stopReason: 'closed',
      finalStatus: 'succeeded',
      finalRevision: 3,
    })
  })

  // ── stops at ask_clarification when clarification needed ───────────────────

  test('behavior_note → ask_clarification applied → stops with requires_product_owner_clarification', async () => {
    const port = makeFakeWorkerPort({
      // Only ask_clarification available (clarification_needed path)
      finalText: JSON.stringify({
        evidence: [{ kind: 'behavior_note', summary: 'ambiguous behavior' }],
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

  // ── stops immediately on already-closed instance ───────────────────────────

  test('an already-closed instance stops at once with zero turns and no run.start or launch', async () => {
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

    expect(result).toEqual({
      taskId: 'T-00001',
      turnsCompleted: 0,
      stopReason: 'closed',
      finalStatus: 'succeeded',
      finalRevision: 5,
    })
    expect(port._calls.map((c) => c.method)).toEqual(['next'])
  })

  // ── stale flag is diagnostics-only ────────────────────────────────────────

  test('a stale instance still gets a participant turn; no legal transition after retries stops blocked_or_ambiguous', async () => {
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
// 5. maxTurns guard
// ===========================================================================

describe('runPbcContinuationWorker — maxTurns', () => {
  test('maxTurns 2 with an always-actionable phase stops max_turns after 2 turns', async () => {
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
