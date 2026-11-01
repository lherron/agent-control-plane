import { describe, expect, test } from 'bun:test'
import {
  behaviorNoteText,
  makeFakeWorkerPort,
  makeNextRaw,
} from '../../test/fixtures/pbc-worker.js'
import { type PbcContinuationWorkerInput, runPbcContinuationWorker } from './worker.js'

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

  test('empty final text within the wait window reports awaiting_participant_output (running) and leaves the run open', async () => {
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

    // Must return non-terminal "still waiting" result; the open run is left live.
    expect(result.stopReason).toBe('awaiting_participant_output')
    for (const method of ['run.fail', 'run.finish', 'transition.apply', 'evidence.add']) {
      expect(port._calls.filter((c) => c.method === method)).toHaveLength(0)
    }
    // The wait window starts: the first-miss timestamp is recorded for later timeout checks.
    expect(
      port._calls.filter((c) => c.method === 'captures.set').map((c) => c.params)
    ).toMatchObject([{ captureKey: 'worker-await-01:output-wait-started-at:1' }])
    expect(result.finalStatus).toBe('running')
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
    expect(launchCalls).toHaveLength(2)
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

  test('final text still missing after the max wait fails the run with missing_final_assistant_text', async () => {
    // The wait window opened 10 minutes ago (recorded on the first miss).
    const TEN_MINUTES_AGO = new Date(Date.now() - 10 * 60 * 1000).toISOString()
    const port = makeFakeWorkerPort({
      finalText: undefined,
      captureStore: { 'worker-timeout-01:output-wait-started-at:1': TEN_MINUTES_AGO },
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

    expect(result.stopReason).toBe('missing_final_assistant_text')
    expect(result.finalStatus).toBe('failed')
    // The elapsed time was read from the recorded wait start ...
    expect(
      port._calls.filter((c) => c.method === 'captures.get').map((c) => c.params)
    ).toContainEqual({ captureKey: 'worker-timeout-01:output-wait-started-at:1' })
    // ... and the open wrkf run is cleaned up as failed, never finished.
    expect(port._calls.filter((c) => c.method === 'run.fail')).toHaveLength(1)
    expect(port._calls.filter((c) => c.method === 'run.finish')).toHaveLength(0)
  })
})
