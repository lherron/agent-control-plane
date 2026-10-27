/**
 * RED TESTS — W3: mutation facades evidence/obligation/transition → wrkf
 *
 * Why red now: all four handlers (handleAttachWorkflowEvidence,
 * handleApplyWorkflowTransition, handleWaiveWorkflowObligation,
 * handleCancelWorkflowObligation) still use withDurableWorkflowKernel (old
 * kernel path). The fake deps.wrkf methods injected here are never called by
 * the current handlers; they hit the kernel instead. Every test below fails
 * until the impl agent rewrites the handlers.
 *
 * What the impl agent must change in
 *   packages/acp-server/src/handlers/workflow-tasks.ts
 * to make these tests green:
 *
 * ── handleAttachWorkflowEvidence ─────────────────────────────────────────────
 *   1. Guard: if deps.wrkf === undefined,
 *        throw new AcpHttpError(503, 'WRKF_UNAVAILABLE', 'wrkf port not available')
 *   2. Replace withDurableWorkflowKernel with a wrkf call per evidence item:
 *        const result = await deps.wrkf.evidence.add({
 *          task: taskId, kind, ref, summary, facts, actor, role,
 *        })
 *      Note: evidence.add has NO expectRevision, idempotencyKey, or runId.
 *   3. For legacy bodies with expectedTaskVersion present:
 *        REJECT with 422 (code: 'legacy_field_not_supported') — OR —
 *        Explicitly ignore with a console.warn compatibility notice.
 *        Never pass it as a precondition; never translate it to expectRevision
 *        (no such param exists on evidence.add).
 *   4. Catch wrkf errors (thrown value with a .code string property):
 *        throw new AcpHttpError(wrkfErrorToHttpStatus(e.code), e.code, e.message)
 *   5. Remove the withDurableWorkflowKernel call from this handler.
 *
 * ── handleApplyWorkflowTransition ────────────────────────────────────────────
 *   1. Guard: if deps.wrkf === undefined, throw 503 WRKF_UNAVAILABLE.
 *   2. Replace withDurableWorkflowKernel with:
 *        const result = await deps.wrkf.transition.apply({
 *          task: taskId,
 *          transition: requireTrimmedStringField(body, 'transitionId'),
 *          role: requireTrimmedStringField(body, 'role'),
 *          actor,
 *          expectRevision: body.expectedTaskVersion ?? undefined,   // alias
 *          contextHash: readOptionalTrimmedStringField(body, 'contextHash'),
 *          idempotencyKey: requireTrimmedStringField(body, 'idempotencyKey'),
 *          // optional: checkIds, runChecks, dryRun if provided in body
 *        })
 *      Do NOT pass evidenceRefs, waiverRefs, inlineEvidence, or runId.
 *   3. After success: enqueue a QUEUED/NO-OP wrkf effect delivery tick (W5
 *      placeholder). Do NOT call reconcileWorkflowEffectIntents or reconcileEffects.
 *   4. Error mapping via wrkfErrorToHttpStatus:
 *        WRKF_STALE_REVISION      → 409
 *        WRKF_CONTEXT_MISMATCH    → 409
 *        WRKF_ROLE_DENIED         → 403
 *        WRKF_IDEMPOTENCY_MISMATCH → 409
 *   5. Remove the withDurableWorkflowKernel call and the reconcileEffects call.
 *
 * ── handleWaiveWorkflowObligation ────────────────────────────────────────────
 *   1. Guard: if deps.wrkf === undefined, throw 503 WRKF_UNAVAILABLE.
 *   2. Replace withDurableWorkflowKernel (including the kernel.listObligations
 *      pre-existence check) with:
 *        const result = await deps.wrkf.obligation.waive({
 *          task: taskId,
 *          id: obligationId,
 *          reason: requireTrimmedStringField(body, 'reason'),
 *        })
 *      Let wrkf return the authoritative error; do NOT pre-check via listObligations.
 *   3. Remove the withDurableWorkflowKernel call and the reconcileEffects call.
 *
 * ── handleCancelWorkflowObligation ───────────────────────────────────────────
 *   1. Guard: if deps.wrkf === undefined, throw 503 WRKF_UNAVAILABLE.
 *   2. Replace withDurableWorkflowKernel (including the kernel.listObligations
 *      pre-existence check) with:
 *        const result = await deps.wrkf.obligation.cancel({
 *          task: taskId,
 *          id: obligationId,
 *          reason,
 *        })
 *      Let wrkf return the authoritative error; do NOT pre-check via listObligations.
 *   3. Remove the withDurableWorkflowKernel call and the reconcileEffects call.
 */

import { describe, expect, test } from 'bun:test'

import { withWiredServer } from '../../test/fixtures/wired-server.js'
import type { AcpWrkfWorkflowPort } from '../wrkf/port.js'

// ── Constants ─────────────────────────────────────────────────────────────────

const TASK_ID = 'T-W3001'
const OBLIGATION_ID = 'OB-W3001'

// ── Canned fixture results returned by the fake wrkf port ─────────────────────

const CANNED_EVIDENCE_RESULT = { id: 'E-W3-001', kind: 'manual', ref: 'ref://w3-test' }
const CANNED_TRANSITION_RESULT = {
  task: { taskId: TASK_ID, version: 2, status: 'in_progress' },
  status: 'applied',
}
const CANNED_OBLIGATION_WAIVE_RESULT = {
  task: { taskId: TASK_ID },
  obligation: { id: OBLIGATION_ID, status: 'waived' },
}
const CANNED_OBLIGATION_CANCEL_RESULT = {
  task: { taskId: TASK_ID },
  obligation: { id: OBLIGATION_ID, status: 'cancelled' },
}

// ── Error class thrown by the fake wrkf port to simulate domain errors ─────────

class WrkfError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'WrkfError'
  }
}

// ── Fake port factory ──────────────────────────────────────────────────────────

type FakePortOverrides = {
  evidenceAdd?: ((params: Record<string, unknown>) => Promise<unknown>) | undefined
  transitionApply?: ((params: Record<string, unknown>) => Promise<unknown>) | undefined
  obligationWaive?: ((params: Record<string, unknown>) => Promise<unknown>) | undefined
  obligationCancel?: ((params: Record<string, unknown>) => Promise<unknown>) | undefined
}

function makeFakeWrkfPort(overrides: FakePortOverrides = {}): AcpWrkfWorkflowPort {
  const notCalled = (name: string) => (): never => {
    throw new Error(`fake AcpWrkfWorkflowPort: ${name} must not be called in this test`)
  }
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
      add: overrides.evidenceAdd ?? (async (_params) => CANNED_EVIDENCE_RESULT),
      list: notCalled('evidence.list'),
      show: notCalled('evidence.show'),
      suggest: notCalled('evidence.suggest'),
    },
    obligation: {
      list: notCalled('obligation.list'),
      show: notCalled('obligation.show'),
      satisfy: notCalled('obligation.satisfy'),
      waive: overrides.obligationWaive ?? (async (_params) => CANNED_OBLIGATION_WAIVE_RESULT),
      cancel: overrides.obligationCancel ?? (async (_params) => CANNED_OBLIGATION_CANCEL_RESULT),
    },
    transition: {
      apply: overrides.transitionApply ?? (async (_params) => CANNED_TRANSITION_RESULT),
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

// ── Test suites ────────────────────────────────────────────────────────────────

// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║  0. Every wrkf mutation route guards a missing wrkf port                    ║
// ╚══════════════════════════════════════════════════════════════════════════════╝

describe('wrkf mutation routes — deps.wrkf undefined guard', () => {
  test.each([
    {
      route: 'POST /evidence',
      path: `/v1/tasks/${TASK_ID}/evidence`,
      body: { kind: 'manual', ref: 'ref://test', actor: { agentId: 'test-agent' }, role: 'tester' },
    },
    {
      route: 'POST /transitions',
      path: `/v1/tasks/${TASK_ID}/transitions`,
      body: {
        transitionId: 'start',
        actor: { agentId: 'test-agent' },
        role: 'owner',
        expectedTaskVersion: 1,
        idempotencyKey: 'idem2',
      },
    },
    {
      route: 'POST /obligations/:id/waive',
      path: `/v1/tasks/${TASK_ID}/obligations/${OBLIGATION_ID}/waive`,
      body: { reason: 'test' },
    },
    {
      route: 'POST /obligations/:id/cancel',
      path: `/v1/tasks/${TASK_ID}/obligations/${OBLIGATION_ID}/cancel`,
      body: { reason: 'test' },
    },
    {
      route: 'POST /obligations/:id/satisfy',
      path: `/v1/tasks/${TASK_ID}/obligations/${OBLIGATION_ID}/satisfy`,
      body: { actor: { agentId: 'test-agent' } },
    },
  ])('$route without deps.wrkf returns 503 WRKF_UNAVAILABLE', async ({ path, body }) => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request({ method: 'POST', path, body })
      expect(response.status).toBe(503)
      const responseBody = await fixture.json<{ error: { code: string } }>(response)
      expect(responseBody.error.code).toBe('WRKF_UNAVAILABLE')
    })
  })
})

// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║  1. handleAttachWorkflowEvidence → deps.wrkf.evidence.add                  ║
// ╚══════════════════════════════════════════════════════════════════════════════╝

describe('W3: POST /v1/tasks/:taskId/evidence — evidence.add wrkf facade', () => {
  test('POST /evidence forwards exactly task, kind, ref, summary, role and the actor as principal_ref to evidence.add', async () => {
    let capturedArgs: Record<string, unknown> | null = null

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/tasks/${TASK_ID}/evidence`,
          body: {
            kind: 'manual',
            ref: 'ref://w3-evidence-test',
            summary: 'Observed correct output',
            actor: { agentId: 'test-agent' },
            role: 'tester',
          },
        })

        expect(response.status).toBe(201)
        // Exact params: no expectRevision / idempotencyKey / runId (evidence.add has none).
        expect(capturedArgs).toEqual({
          task: TASK_ID,
          kind: 'manual',
          principal_ref: 'agent:test-agent',
          ref: 'ref://w3-evidence-test',
          summary: 'Observed correct output',
          role: 'tester',
        })
      },
      {
        wrkf: makeFakeWrkfPort({
          evidenceAdd: async (params) => {
            capturedArgs = params as Record<string, unknown>
            return CANNED_EVIDENCE_RESULT
          },
        }),
      }
    )
  })

  test('legacy expectedTaskVersion on POST /evidence is ignored: evidence.add is called without expectRevision', async () => {
    let capturedArgs: Record<string, unknown> | null = null

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/tasks/${TASK_ID}/evidence`,
          body: {
            kind: 'manual',
            ref: 'ref://legacy-version-test',
            actor: { agentId: 'test-agent' },
            role: 'tester',
            expectedTaskVersion: 1,
          },
        })

        // Not honored as a CAS guard (no 409 stale / 412 precondition).
        expect(response.status).not.toBe(409)
        expect(response.status).not.toBe(412)

        expect(capturedArgs).not.toBeNull()
        expect(capturedArgs!['expectRevision']).toBeUndefined()
        expect(capturedArgs!['expectedTaskVersion']).toBeUndefined()
      },
      {
        wrkf: makeFakeWrkfPort({
          evidenceAdd: async (params) => {
            capturedArgs = params as Record<string, unknown>
            return CANNED_EVIDENCE_RESULT
          },
        }),
      }
    )
  })
})

// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║  2. handleApplyWorkflowTransition → deps.wrkf.transition.apply             ║
// ╚══════════════════════════════════════════════════════════════════════════════╝

describe('W3: POST /v1/tasks/:taskId/transitions — transition.apply wrkf facade', () => {
  // Shared valid body for transition requests (all required fields for new handler)
  const VALID_TRANSITION_BODY = {
    transitionId: 'start',
    actor: { agentId: 'test-agent' },
    role: 'owner',
    expectedTaskVersion: 1,
    idempotencyKey: 'idem2',
  }

  test('POST /transitions forwards exactly task, transition, role, principal_ref, expectRevision, idempotencyKey and drops legacy evidence fields', async () => {
    let capturedArgs: Record<string, unknown> | null = null

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/tasks/${TASK_ID}/transitions`,
          body: {
            ...VALID_TRANSITION_BODY,
            // Legacy fields wrkf transition.apply does not accept — must not be forwarded.
            evidenceRefs: ['E-001', 'E-002'],
            waiverRefs: ['W-001'],
            inlineEvidence: [{ kind: 'manual', ref: 'ref://inline' }],
            runId: 'run-legacy-001',
          },
        })

        expect(response.status).toBe(200)
        expect(capturedArgs).toEqual({
          task: TASK_ID,
          transition: 'start', // mapped from transitionId
          role: 'owner',
          principal_ref: 'agent:test-agent',
          expectRevision: 1, // aliased from expectedTaskVersion
          idempotencyKey: 'idem2',
        })
      },
      {
        wrkf: makeFakeWrkfPort({
          transitionApply: async (params) => {
            capturedArgs = params as Record<string, unknown>
            return CANNED_TRANSITION_RESULT
          },
        }),
      }
    )
  })

  // ── wrkf error → HTTP status mapping (the full wrkfErrorToHttpStatus table) ─
  describe('wrkf error → HTTP status mapping', () => {
    const ERROR_TABLE: Array<[wrkfCode: string, expectedHttp: number]> = [
      ['WRKF_NOT_FOUND', 404],
      ['WRKF_ROLE_DENIED', 403],
      ['WRKF_STALE_REVISION', 409],
      ['WRKF_CONTEXT_MISMATCH', 409],
      ['WRKF_IDEMPOTENCY_MISMATCH', 409],
      ['WRKF_LEASE_CONFLICT', 409],
      ['WRKF_TRANSITION_BLOCKED', 422],
      ['WRKF_VALIDATION', 422],
      ['WRKF_EFFECT_NOT_DELIVERABLE', 422],
      ['WRKF_DB_MIGRATION_REQUIRED', 503],
      ['WRKF_INTERNAL', 500],
      // ACP-synthesized for transport / process-death failures (not a wrkf domain code).
      ['WRKF_UNAVAILABLE', 503],
      // Unknown / future codes (and RPC_* protocol fallbacks) take the safe default.
      ['WRKF_SOME_FUTURE_CODE', 500],
      ['RPC_-32603', 500],
    ]

    for (const [wrkfCode, expectedHttp] of ERROR_TABLE) {
      test(`${wrkfCode} thrown by transition.apply → HTTP ${expectedHttp} with error.code === "${wrkfCode}"`, async () => {
        await withWiredServer(
          async (fixture) => {
            const response = await fixture.request({
              method: 'POST',
              path: `/v1/tasks/${TASK_ID}/transitions`,
              body: VALID_TRANSITION_BODY,
            })
            expect(response.status).toBe(expectedHttp)
            const body = await fixture.json<{ error: { code: string } }>(response)
            expect(body.error.code).toBe(wrkfCode)
          },
          {
            wrkf: makeFakeWrkfPort({
              transitionApply: async (_params) => {
                throw new WrkfError(wrkfCode, `${wrkfCode}: test error`)
              },
            }),
          }
        )
      })
    }
  })
})

// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║  3. handleWaiveWorkflowObligation → deps.wrkf.obligation.waive             ║
// ╚══════════════════════════════════════════════════════════════════════════════╝

describe('W3: POST /v1/tasks/:taskId/obligations/:obligationId/waive — obligation.waive wrkf facade', () => {
  describe('obligation.waive delegation without ACP pre-check (RED: handler short-circuits via listObligations)', () => {
    test('obligation.waive is called with task, id (obligationId), reason — no listObligations pre-check', async () => {
      let capturedArgs: Record<string, unknown> | null = null

      await withWiredServer(
        async (fixture) => {
          const response = await fixture.request({
            method: 'POST',
            path: `/v1/tasks/${TASK_ID}/obligations/${OBLIGATION_ID}/waive`,
            body: {
              reason: 'Waived for testing — wrkf is authoritative',
            },
          })

          // Handler must reach obligation.waive and return 2xx
          expect(response.status).toBeGreaterThanOrEqual(200)
          expect(response.status).toBeLessThan(300)

          // Spy: obligation.waive must have been called
          expect(capturedArgs).not.toBeNull()

          // Shape: required wrkf params
          expect(capturedArgs!['task']).toBe(TASK_ID)
          expect(capturedArgs!['id']).toBe(OBLIGATION_ID)
          expect(capturedArgs!['reason']).toBe('Waived for testing — wrkf is authoritative')
        },
        {
          wrkf: makeFakeWrkfPort({
            obligationWaive: async (params) => {
              capturedArgs = params as Record<string, unknown>
              return CANNED_OBLIGATION_WAIVE_RESULT
            },
          }),
        }
      )
    })
  })
})

// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║  4. handleCancelWorkflowObligation → deps.wrkf.obligation.cancel           ║
// ╚══════════════════════════════════════════════════════════════════════════════╝

describe('W3: POST /v1/tasks/:taskId/obligations/:obligationId/cancel — obligation.cancel wrkf facade', () => {
  describe('obligation.cancel delegation without ACP pre-check (RED: handler short-circuits via listObligations)', () => {
    test('obligation.cancel is called with task, id (obligationId), reason — no listObligations pre-check', async () => {
      let capturedArgs: Record<string, unknown> | null = null

      await withWiredServer(
        async (fixture) => {
          const response = await fixture.request({
            method: 'POST',
            path: `/v1/tasks/${TASK_ID}/obligations/${OBLIGATION_ID}/cancel`,
            body: {
              reason: 'Cancelled for testing — wrkf is authoritative',
            },
          })

          expect(response.status).toBeGreaterThanOrEqual(200)
          expect(response.status).toBeLessThan(300)

          expect(capturedArgs).not.toBeNull()
          expect(capturedArgs!['task']).toBe(TASK_ID)
          expect(capturedArgs!['id']).toBe(OBLIGATION_ID)
          expect(capturedArgs!['reason']).toBe('Cancelled for testing — wrkf is authoritative')
        },
        {
          wrkf: makeFakeWrkfPort({
            obligationCancel: async (params) => {
              capturedArgs = params as Record<string, unknown>
              return CANNED_OBLIGATION_CANCEL_RESULT
            },
          }),
        }
      )
    })
  })
})
