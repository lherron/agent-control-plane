import { describe, expect, test } from 'bun:test'
import {
  behaviorNoteText,
  freshDraftTimeline,
  makeFakeWorkerPort,
  makeNextRaw,
  pbcDraftText,
  pressurePassText,
} from '../../test/fixtures/pbc-worker.js'
import { type PbcContinuationWorkerInput, runPbcContinuationWorker } from './worker.js'

// ===========================================================================
// 4. DISPOSITION NEVER SELECTED BY WORKER
// ===========================================================================

describe('runPbcContinuationWorker — disposition gate', () => {
  test.each([
    {
      phase: 'behavior_note',
      transition: 'dispose_from_behavior_note',
      finalText: behaviorNoteText({ clarificationNeeded: false }),
      evidence: [] as Record<string, unknown>[],
      revision: 1,
      pressureActor: undefined,
    },
    {
      phase: 'pbc_draft',
      transition: 'dispose_from_pbc_draft',
      finalText: pbcDraftText(),
      evidence: freshDraftTimeline(),
      revision: 3,
      pressureActor: undefined,
    },
    {
      phase: 'pressure',
      transition: 'dispose_from_pressure',
      finalText: pressurePassText('ev_draft_1'),
      evidence: freshDraftTimeline(),
      revision: 5,
      pressureActor: 'agent:pressure-reviewer',
    },
  ])(
    'a $phase phase offering only $transition is never disposed by the worker and stops blocked_or_ambiguous',
    async ({ phase, transition, finalText, evidence, revision, pressureActor }) => {
      const port = makeFakeWorkerPort({
        finalText,
        evidence,
        nextSequence: [
          makeNextRaw({ status: 'active', phase, revision, actions: [{ transition }] }),
          makeNextRaw({
            status: 'active',
            phase,
            revision: revision + 1,
            actions: [{ transition }],
          }),
        ],
      })

      const result = await runPbcContinuationWorker(port, {
        taskId: 'T-00001',
        idempotencyKey: `worker-no-${transition}`,
        actor: 'agent:pbc-writer',
        ...(pressureActor !== undefined ? { pressureActor } : {}),
        maxTurns: 1,
      } satisfies PbcContinuationWorkerInput)

      expect(port._calls.filter((c) => c.method === 'transition.apply')).toHaveLength(0)
      expect(result.stopReason).toBe('blocked_or_ambiguous')
    }
  )
})
