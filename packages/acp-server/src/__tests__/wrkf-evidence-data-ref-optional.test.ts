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

/** POST /v1/tasks/:taskId/evidence and capture the outbound wrkf evidence.add params. */
async function postEvidence(
  body: Record<string, unknown>
): Promise<{ status: number; args: Record<string, unknown> | null; body: unknown }> {
  let capturedArgs: Record<string, unknown> | null = null
  return withWiredServer(
    async (fixture) => {
      const response = await fixture.request({
        method: 'POST',
        path: `/v1/tasks/${TASK_ID}/evidence`,
        body,
      })
      return { status: response.status, args: capturedArgs, body: await response.json() }
    },
    {
      wrkf: makeFakeWrkfPort({
        evidenceAdd: async (params) => {
          capturedArgs = params as Record<string, unknown>
          return { id: 'ev_001', kind: String(params['kind']) }
        },
      }),
    }
  )
}

// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║  1. `ref` is optional — POST without ref must succeed                       ║
// ╚══════════════════════════════════════════════════════════════════════════════╝

describe('P1-D1: POST /v1/tasks/:taskId/evidence — ref is optional', () => {
  test('POST without ref but with summary succeeds and calls evidence.add without ref param', async () => {
    const result = await postEvidence({
      kind: 'data_submission',
      summary: 'data submitted without ref',
      actor: { agentId: 'test-agent' },
      role: 'owner',
    })

    expect(result.status).toBe(201)
    expect(result.args).not.toBeNull()
    // ref must be absent from the evidence.add call (not passed as undefined)
    expect('ref' in result.args!).toBe(false)
    expect(result.args!['summary']).toBe('data submitted without ref')
  })
})

// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║  2. `data` is forwarded to wrkf.evidence.add                                ║
// ╚══════════════════════════════════════════════════════════════════════════════╝

describe('P1-D1: POST /v1/tasks/:taskId/evidence — data forwarded to wrkf', () => {
  test.each([
    { name: 'object', data: { score: 98, verdict: 'pass', metadata: { source: 'automated' } } },
    { name: 'string', data: 'raw string data value' },
    {
      name: 'array',
      data: [
        { step: 1, result: 'ok' },
        { step: 2, result: 'ok' },
      ],
    },
  ])('data $name is forwarded to evidence.add when provided', async ({ data }) => {
    const result = await postEvidence({
      kind: 'score_result',
      data,
      actor: { agentId: 'test-agent' },
      role: 'assessor',
    })

    expect(result.status).toBe(201)
    expect(result.args).not.toBeNull()
    expect(result.args!['data']).toEqual(data)
  })

  test('when data is absent, evidence.add is called without data key', async () => {
    const result = await postEvidence({
      kind: 'manual',
      ref: 'ref://no-data',
      actor: { agentId: 'test-agent' },
    })

    expect(result.args).not.toBeNull()
    // data should be absent from the call (not `undefined` — not included at all)
    expect('data' in result.args!).toBe(false)
  })

  test('POST with both ref and data: both forwarded to evidence.add', async () => {
    const result = await postEvidence({
      kind: 'approval',
      ref: 'ref://approval-doc',
      data: { approved: true },
      actor: { agentId: 'test-agent' },
      role: 'approver',
    })

    expect(result.status).toBe(201)
    expect(result.args).not.toBeNull()
    expect(result.args!['ref']).toBe('ref://approval-doc')
    expect(result.args!['data']).toEqual({ approved: true })
  })
})

// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║  3. kind still required, body validation preserved                          ║
// ╚══════════════════════════════════════════════════════════════════════════════╝

describe('P1-D1: POST /v1/tasks/:taskId/evidence — kind still required', () => {
  test('POST without kind returns 400 malformed_request naming field "kind" and never calls wrkf', async () => {
    const result = await postEvidence({
      summary: 'no kind',
      actor: { agentId: 'test-agent' },
      data: { someValue: true },
    })

    expect(result.status).toBe(400)
    expect(result.body).toMatchObject({
      error: { code: 'malformed_request', details: { field: 'kind' } },
    })
    expect(result.args).toBeNull()
  })

  test('facts as an array is rejected 422 invalid_evidence naming field "facts" and never calls wrkf', async () => {
    const result = await postEvidence({
      kind: 'manual',
      facts: ['not', 'an', 'object'],
      actor: { agentId: 'test-agent' },
      // No ref — facts validation runs even without ref
    })

    expect(result.status).toBe(422)
    expect(result.body).toMatchObject({
      error: { code: 'invalid_evidence', details: { field: 'facts' } },
    })
    expect(result.args).toBeNull()
  })
})
