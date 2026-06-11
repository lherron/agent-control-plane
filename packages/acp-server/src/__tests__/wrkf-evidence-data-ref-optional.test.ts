/**
 * Red tests — Phase 1, Deliverable 1:
 * POST /v1/tasks/:taskId/evidence forwards `data` and allows missing `ref`.
 *
 * WHY RED NOW:
 *   Line 230 in src/handlers/workflow-tasks.ts:
 *     const ref = requireTrimmedStringField(body, 'ref')
 *   This throws an UnprocessableError when `ref` is absent → 422.
 *   The handler also never reads `data` from the body, so it is silently dropped.
 *
 * WHAT THE IMPL AGENT MUST CHANGE in src/handlers/workflow-tasks.ts
 * (handleAttachWorkflowEvidence, lines ~210-255):
 *
 *   1. Make `ref` optional:
 *        const ref = readOptionalTrimmedStringField(body, 'ref')
 *
 *   2. Read `data` from body (optional unknown):
 *        const data = body['data']  // any JSON value including undefined
 *
 *   3. Forward `data` and optional `ref` to wrkf.evidence.add:
 *        await wrkf.evidence.add({
 *          task: taskId, kind, actor: wrkfActor,
 *          ...(ref !== undefined ? { ref } : {}),
 *          ...(summary !== undefined ? { summary } : {}),
 *          ...(facts !== undefined ? { facts } : {}),
 *          ...(data !== undefined ? { data } : {}),
 *          ...(role !== undefined ? { role } : {}),
 *        })
 *
 *   4. Keep `kind` required.
 *   5. Keep validation: `facts` must be an object/record if present.
 */

import { describe, expect, test } from 'bun:test'

import { withWiredServer } from '../../test/fixtures/wired-server.js'
import type { AcpWrkfWorkflowPort } from '../wrkf/port.js'

// ── Constants ─────────────────────────────────────────────────────────────────

const TASK_ID = 'T-P1D1-001'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeFakeWrkfPort(
  overrides: {
    evidenceAdd?: ((params: Record<string, unknown>) => Promise<unknown>) | undefined
  } = {}
): AcpWrkfWorkflowPort {
  const notCalled = (name: string) => (): never => {
    throw new Error(`fake AcpWrkfWorkflowPort: ${name} must not be called in this test`)
  }
  const defaultEvidenceResult = { id: 'ev_fake_001', kind: 'manual' }
  return {
    workflow: {
      validate: notCalled('workflow.validate'),
      show: notCalled('workflow.show'),
      list: notCalled('workflow.list'),
      diff: notCalled('workflow.diff'),
      install: notCalled('workflow.install'),
    },
    task: {
      attach: notCalled('task.attach'),
      inspect: notCalled('task.inspect'),
      timeline: notCalled('task.timeline'),
      refresh: notCalled('task.refresh'),
      syncMeta: notCalled('task.syncMeta'),
    },
    next: notCalled('next'),
    evidence: {
      add: overrides.evidenceAdd ?? (async (_params) => defaultEvidenceResult),
      list: notCalled('evidence.list'),
      show: notCalled('evidence.show'),
      suggest: notCalled('evidence.suggest'),
    },
    obligation: {
      list: notCalled('obligation.list'),
      show: notCalled('obligation.show'),
      satisfy: notCalled('obligation.satisfy'),
      waive: notCalled('obligation.waive'),
      cancel: notCalled('obligation.cancel'),
    },
    transition: {
      apply: notCalled('transition.apply'),
    },
    run: {
      start: notCalled('run.start'),
      bindExternal: notCalled('run.bindExternal'),
      finish: notCalled('run.finish'),
      fail: notCalled('run.fail'),
      show: notCalled('run.show'),
      list: notCalled('run.list'),
    },
    effect: {
      list: notCalled('effect.list'),
      show: notCalled('effect.show'),
      claim: notCalled('effect.claim'),
      ack: notCalled('effect.ack'),
      fail: notCalled('effect.fail'),
      retry: notCalled('effect.retry'),
      deliver: notCalled('effect.deliver'),
    },
  }
}

// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║  1. `ref` is optional — POST without ref must succeed                       ║
// ╚══════════════════════════════════════════════════════════════════════════════╝

describe('P1-D1: POST /v1/tasks/:taskId/evidence — ref is optional', () => {
  // RED: handler calls requireTrimmedStringField(body, 'ref') → throws 422 when ref absent.
  // After impl: readOptionalTrimmedStringField(body, 'ref') → succeeds, evidence.add called.

  test('POST without ref field returns 2xx (ref is optional)', async () => {
    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/tasks/${TASK_ID}/evidence`,
          body: {
            kind: 'data_submission',
            actor: { agentId: 'test-agent' },
            role: 'owner',
            // NO ref field
          },
        })
        // RED: currently returns 422 because requireTrimmedStringField('ref') throws
        expect(response.status).toBeGreaterThanOrEqual(200)
        expect(response.status).toBeLessThan(300)
      },
      { wrkf: makeFakeWrkfPort() }
    )
  })

  test('POST without ref but with summary succeeds and calls evidence.add without ref param', async () => {
    let capturedArgs: Record<string, unknown> | null = null

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/tasks/${TASK_ID}/evidence`,
          body: {
            kind: 'data_submission',
            summary: 'data submitted without ref',
            actor: { agentId: 'test-agent' },
            role: 'owner',
          },
        })

        // RED: returns 422 before reaching evidence.add
        expect(response.status).toBeGreaterThanOrEqual(200)
        expect(response.status).toBeLessThan(300)
        expect(capturedArgs).not.toBeNull()
        // ref must be absent from the evidence.add call (not passed as undefined)
        expect(capturedArgs!['ref']).toBeUndefined()
        expect(capturedArgs!['summary']).toBe('data submitted without ref')
      },
      {
        wrkf: makeFakeWrkfPort({
          evidenceAdd: async (params) => {
            capturedArgs = params as Record<string, unknown>
            return { id: 'ev_001', kind: 'data_submission' }
          },
        }),
      }
    )
  })

  test('POST with ref still works — ref forwarded to evidence.add', async () => {
    let capturedArgs: Record<string, unknown> | null = null

    await withWiredServer(
      async (fixture) => {
        await fixture.request({
          method: 'POST',
          path: `/v1/tasks/${TASK_ID}/evidence`,
          body: {
            kind: 'manual',
            ref: 'ref://p1d1-test',
            actor: { agentId: 'test-agent' },
            role: 'owner',
          },
        })
        expect(capturedArgs).not.toBeNull()
        expect(capturedArgs!['ref']).toBe('ref://p1d1-test')
      },
      {
        wrkf: makeFakeWrkfPort({
          evidenceAdd: async (params) => {
            capturedArgs = params as Record<string, unknown>
            return { id: 'ev_002', kind: 'manual' }
          },
        }),
      }
    )
  })
})

// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║  2. `data` is forwarded to wrkf.evidence.add                                ║
// ╚══════════════════════════════════════════════════════════════════════════════╝

describe('P1-D1: POST /v1/tasks/:taskId/evidence — data forwarded to wrkf', () => {
  // RED: handler never reads `data` from body → evidence.add receives no `data`.
  // After impl: body['data'] is read and passed to evidence.add if present.

  test('data object is forwarded to evidence.add when provided', async () => {
    let capturedArgs: Record<string, unknown> | null = null
    const DATA_PAYLOAD = { score: 98, verdict: 'pass', metadata: { source: 'automated' } }

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/tasks/${TASK_ID}/evidence`,
          body: {
            kind: 'score_result',
            data: DATA_PAYLOAD,
            actor: { agentId: 'test-agent' },
            role: 'assessor',
          },
        })

        // RED: evidence.add is reached (wrkf path works) but data is absent from params
        expect(response.status).toBeGreaterThanOrEqual(200)
        expect(response.status).toBeLessThan(300)
        expect(capturedArgs).not.toBeNull()
        // RED: capturedArgs!['data'] will be undefined (not forwarded)
        expect(capturedArgs!['data']).toEqual(DATA_PAYLOAD)
      },
      {
        wrkf: makeFakeWrkfPort({
          evidenceAdd: async (params) => {
            capturedArgs = params as Record<string, unknown>
            return { id: 'ev_003', kind: 'score_result' }
          },
        }),
      }
    )
  })

  test('data string value is forwarded to evidence.add', async () => {
    let capturedArgs: Record<string, unknown> | null = null

    await withWiredServer(
      async (fixture) => {
        await fixture.request({
          method: 'POST',
          path: `/v1/tasks/${TASK_ID}/evidence`,
          body: {
            kind: 'text_note',
            data: 'raw string data value',
            actor: { agentId: 'test-agent' },
          },
        })
        expect(capturedArgs).not.toBeNull()
        // RED: data is undefined in capturedArgs (handler drops it)
        expect(capturedArgs!['data']).toBe('raw string data value')
      },
      {
        wrkf: makeFakeWrkfPort({
          evidenceAdd: async (params) => {
            capturedArgs = params as Record<string, unknown>
            return { id: 'ev_004', kind: 'text_note' }
          },
        }),
      }
    )
  })

  test('data array value is forwarded to evidence.add', async () => {
    let capturedArgs: Record<string, unknown> | null = null
    const DATA_ARRAY = [
      { step: 1, result: 'ok' },
      { step: 2, result: 'ok' },
    ]

    await withWiredServer(
      async (fixture) => {
        await fixture.request({
          method: 'POST',
          path: `/v1/tasks/${TASK_ID}/evidence`,
          body: {
            kind: 'step_results',
            data: DATA_ARRAY,
            actor: { agentId: 'test-agent' },
          },
        })
        expect(capturedArgs).not.toBeNull()
        // RED: data is undefined in capturedArgs
        expect(capturedArgs!['data']).toEqual(DATA_ARRAY)
      },
      {
        wrkf: makeFakeWrkfPort({
          evidenceAdd: async (params) => {
            capturedArgs = params as Record<string, unknown>
            return { id: 'ev_005', kind: 'step_results' }
          },
        }),
      }
    )
  })

  test('when data is absent, evidence.add is called without data key', async () => {
    let capturedArgs: Record<string, unknown> | null = null

    await withWiredServer(
      async (fixture) => {
        await fixture.request({
          method: 'POST',
          path: `/v1/tasks/${TASK_ID}/evidence`,
          body: {
            kind: 'manual',
            ref: 'ref://no-data',
            actor: { agentId: 'test-agent' },
          },
        })
        expect(capturedArgs).not.toBeNull()
        // data should be absent from the call (not `undefined` — not included at all)
        expect('data' in capturedArgs!).toBe(false)
      },
      {
        wrkf: makeFakeWrkfPort({
          evidenceAdd: async (params) => {
            capturedArgs = params as Record<string, unknown>
            return { id: 'ev_006', kind: 'manual' }
          },
        }),
      }
    )
  })

  test('POST with both ref and data: both forwarded to evidence.add', async () => {
    let capturedArgs: Record<string, unknown> | null = null
    const DATA_PAYLOAD = { approved: true }

    await withWiredServer(
      async (fixture) => {
        await fixture.request({
          method: 'POST',
          path: `/v1/tasks/${TASK_ID}/evidence`,
          body: {
            kind: 'approval',
            ref: 'ref://approval-doc',
            data: DATA_PAYLOAD,
            actor: { agentId: 'test-agent' },
            role: 'approver',
          },
        })
        expect(capturedArgs).not.toBeNull()
        expect(capturedArgs!['ref']).toBe('ref://approval-doc')
        // RED: data is undefined
        expect(capturedArgs!['data']).toEqual(DATA_PAYLOAD)
      },
      {
        wrkf: makeFakeWrkfPort({
          evidenceAdd: async (params) => {
            capturedArgs = params as Record<string, unknown>
            return { id: 'ev_007', kind: 'approval' }
          },
        }),
      }
    )
  })
})

// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║  3. kind still required, body validation preserved                          ║
// ╚══════════════════════════════════════════════════════════════════════════════╝

describe('P1-D1: POST /v1/tasks/:taskId/evidence — kind still required', () => {
  // These tests verify that making `ref` optional does NOT relax `kind` validation.
  // They are RED now because the handler fails at `ref` before `kind` can be validated
  // when both are absent; after the fix `ref` is optional and the handler correctly
  // reaches kind validation.

  test('POST without kind returns 4xx — kind is still required', async () => {
    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/tasks/${TASK_ID}/evidence`,
          body: {
            // kind is missing — must still be required
            summary: 'no kind',
            actor: { agentId: 'test-agent' },
            data: { someValue: true },
          },
        })
        // RED (current): handler fails at ref-required (400) before kind check.
        // After fix: ref optional → kind check fires → 400 (kind required).
        // Both are 4xx — the test proves kind is still required after the fix.
        expect(response.status).toBeGreaterThanOrEqual(400)
        expect(response.status).toBeLessThan(500)
      },
      { wrkf: makeFakeWrkfPort() }
    )
  })

  test('facts as array is rejected with 4xx — facts must be an object/record', async () => {
    // RED (current): handler fails at requireTrimmedStringField('ref') → 400.
    // After fix: ref optional → readOptionalRecordField('facts') → badRequest for array → 400.
    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/tasks/${TASK_ID}/evidence`,
          body: {
            kind: 'manual',
            facts: ['not', 'an', 'object'],
            actor: { agentId: 'test-agent' },
            // No ref — tests that facts validation runs even without ref (after fix)
          },
        })
        expect(response.status).toBeGreaterThanOrEqual(400)
        expect(response.status).toBeLessThan(500)
      },
      { wrkf: makeFakeWrkfPort() }
    )
  })
})
