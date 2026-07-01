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

import { readFileSync } from 'node:fs'

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
// ║  1. handleAttachWorkflowEvidence → deps.wrkf.evidence.add                  ║
// ╚══════════════════════════════════════════════════════════════════════════════╝

describe('W3: POST /v1/tasks/:taskId/evidence — evidence.add wrkf facade', () => {
  // ── 1a. evidence.add is called with the correct wrkf params ──────────────────
  //
  // RED because: current handler calls kernel.attachEvidence via
  // withDurableWorkflowKernel. The fake evidence.add spy is never invoked.
  // capturedArgs remains null → expect(capturedArgs).not.toBeNull() fails.
  //
  describe('evidence.add delegation (RED: handler calls kernel, evidence.add never invoked)', () => {
    test('evidence.add is called with task, kind, ref, summary, actor, role', async () => {
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

          // Handler must reach evidence.add and return 2xx
          expect(response.status).toBeGreaterThanOrEqual(200)
          expect(response.status).toBeLessThan(300)

          // Spy assertion: evidence.add must have been called once
          expect(capturedArgs).not.toBeNull()

          // Shape assertion: all required wrkf params present
          expect(capturedArgs!['task']).toBe(TASK_ID)
          expect(capturedArgs!['kind']).toBe('manual')
          expect(capturedArgs!['ref']).toBe('ref://w3-evidence-test')
          expect(capturedArgs!['summary']).toBe('Observed correct output')
          expect(capturedArgs!['principal_ref']).toBe('agent:test-agent')
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

    test('evidence.add params must NOT include expectRevision, idempotencyKey, or runId', async () => {
      let capturedArgs: Record<string, unknown> | null = null

      await withWiredServer(
        async (fixture) => {
          const response = await fixture.request({
            method: 'POST',
            path: `/v1/tasks/${TASK_ID}/evidence`,
            body: {
              kind: 'test_run',
              ref: 'ref://run-output',
              actor: { agentId: 'test-agent' },
              role: 'participant',
            },
          })

          expect(response.status).toBeGreaterThanOrEqual(200)
          expect(response.status).toBeLessThan(300)
          expect(capturedArgs).not.toBeNull()

          // These params do not exist on evidence.add — impl must NOT pass them
          expect(capturedArgs!['expectRevision']).toBeUndefined()
          expect(capturedArgs!['idempotencyKey']).toBeUndefined()
          expect(capturedArgs!['runId']).toBeUndefined()
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

  // ── 1b. Legacy expectedTaskVersion is not silently honored ───────────────────
  //
  // RED because: current handler uses withDurableWorkflowKernel which may treat
  // expectedTaskVersion as a real kernel CAS guard; and evidence.add is never
  // called at all. After impl: evidence.add is called, but without passing the
  // legacy field as a wrkf precondition.
  //
  describe('legacy expectedTaskVersion handling (RED: handler passes version to kernel, not ignored)', () => {
    test('expectedTaskVersion in body does NOT appear as expectRevision in the evidence.add call', async () => {
      let capturedArgs: Record<string, unknown> | null = null

      await withWiredServer(
        async (fixture) => {
          await fixture.request({
            method: 'POST',
            path: `/v1/tasks/${TASK_ID}/evidence`,
            body: {
              kind: 'manual',
              ref: 'ref://legacy-test',
              actor: { agentId: 'test-agent' },
              role: 'tester',
              // Legacy field — wrkf evidence.add has no such param
              expectedTaskVersion: 99,
            },
          })

          // If evidence.add was reached, it must not carry the legacy field
          if (capturedArgs !== null) {
            expect(capturedArgs['expectRevision']).toBeUndefined()
            expect(capturedArgs['expectedTaskVersion']).toBeUndefined()
          }

          // The handler must have called evidence.add (not silently short-circuited)
          // OR explicitly rejected the request with a 4xx (never silently honored
          // the version as a real wrkf precondition, never returned 409 as if stale).
          //
          // This assertion captures the invariant: if evidence.add was reached,
          // capturedArgs is non-null and the legacy field is absent from the call.
          // If the handler chose to REJECT instead (422 legacy_field_not_supported),
          // capturedArgs stays null and the test still passes — both behaviors are
          // acceptable as long as the field is NOT silently honored.
          //
          // The test below proves the field is absent from the wrkf call when
          // the handler reaches evidence.add:
          expect(capturedArgs).not.toBeNull()
          expect(capturedArgs!['expectRevision']).toBeUndefined()
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

    test('when expectedTaskVersion is present, evidence.add is still called (handler reaches wrkf, not short-circuited by a phantom CAS guard)', async () => {
      // RED because: current handler never calls evidence.add at all. After impl, the
      // handler must reach evidence.add regardless of expectedTaskVersion in the body —
      // either by ignoring it (with warning) or by first rejecting with an explicit code
      // before reaching wrkf. This spy-based test ensures the field is NOT treated as a
      // silent precondition that blocks the wrkf call.
      //
      // To make the impl green: when expectedTaskVersion is present, the handler must
      // either (a) call evidence.add and NOT include expectRevision in the params, OR
      // (b) reject early with a non-generic rejection code (not 409 stale-revision).
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

          // The response must NOT be a 409 stale-revision (that would mean the legacy
          // field was silently honored as a real version guard).
          expect(response.status).not.toBe(409)
          expect(response.status).not.toBe(412)

          // evidence.add must have been called and NOT received expectRevision.
          // This is the primary RED assertion — current handler never reaches evidence.add.
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

  // ── 1c. deps.wrkf undefined → 503 WRKF_UNAVAILABLE ─────────────────────────
  //
  // RED because: current handler ignores deps.wrkf entirely. Without wrkf injected
  // the kernel path runs → kernel.attachEvidence fails with task_not_found → 422.
  // Test asserts 503.
  //
  describe('deps.wrkf undefined guard (RED: current handler ignores wrkf, kernel → 422)', () => {
    test('POST /evidence without deps.wrkf returns 503 WRKF_UNAVAILABLE', async () => {
      await withWiredServer(async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/tasks/${TASK_ID}/evidence`,
          body: {
            kind: 'manual',
            ref: 'ref://test',
            actor: { agentId: 'test-agent' },
            role: 'tester',
          },
        })
        expect(response.status).toBe(503)
        const body = await fixture.json<{ error: { code: string } }>(response)
        expect(body.error.code).toBe('WRKF_UNAVAILABLE')
      })
    })
  })

  // ── 1d. Source: handleAttachWorkflowEvidence must not use withDurableWorkflowKernel
  //
  // RED because: current handler calls withDurableWorkflowKernel.
  //
  describe('handler source does not use withDurableWorkflowKernel (RED: currently calls it)', () => {
    test('handleAttachWorkflowEvidence function body does not contain withDurableWorkflowKernel', () => {
      const src = readFileSync(new URL('../handlers/workflow-tasks.ts', import.meta.url), 'utf-8')
      const start = src.indexOf('export const handleAttachWorkflowEvidence')
      expect(start).toBeGreaterThan(-1)
      const nextExport = src.indexOf('\nexport const handle', start + 1)
      const body = nextExport === -1 ? src.slice(start) : src.slice(start, nextExport)
      expect(body).not.toContain('withDurableWorkflowKernel')
    })
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
    idempotencyKey: 'idem-w3-trans-001',
  }

  // ── 2a. transition.apply is called with correct wrkf params ─────────────────
  //
  // RED because: current handler calls kernel.applyTransition via
  // withDurableWorkflowKernel. The fake transition.apply spy is never invoked.
  //
  describe('transition.apply delegation (RED: handler calls kernel, transition.apply never invoked)', () => {
    test('transition.apply is called with task, transition (from transitionId), role, actor, expectRevision, idempotencyKey', async () => {
      let capturedArgs: Record<string, unknown> | null = null

      await withWiredServer(
        async (fixture) => {
          const response = await fixture.request({
            method: 'POST',
            path: `/v1/tasks/${TASK_ID}/transitions`,
            body: VALID_TRANSITION_BODY,
          })

          expect(response.status).toBeGreaterThanOrEqual(200)
          expect(response.status).toBeLessThan(300)

          // Spy: transition.apply must have been called
          expect(capturedArgs).not.toBeNull()

          // Shape: required params
          expect(capturedArgs!['task']).toBe(TASK_ID)
          expect(capturedArgs!['transition']).toBe('start') // mapped from transitionId
          expect(capturedArgs!['role']).toBe('owner')
          expect(capturedArgs!['expectRevision']).toBe(1) // aliased from expectedTaskVersion
          expect(capturedArgs!['idempotencyKey']).toBe('idem-w3-trans-001')
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

    test('transition.apply params must NOT include evidenceRefs, waiverRefs, inlineEvidence, or runId', async () => {
      let capturedArgs: Record<string, unknown> | null = null

      await withWiredServer(
        async (fixture) => {
          const response = await fixture.request({
            method: 'POST',
            path: `/v1/tasks/${TASK_ID}/transitions`,
            body: {
              ...VALID_TRANSITION_BODY,
              // These legacy fields must NOT be forwarded to transition.apply
              evidenceRefs: ['E-001', 'E-002'],
              waiverRefs: ['W-001'],
              inlineEvidence: [{ kind: 'manual', ref: 'ref://inline' }],
              runId: 'run-legacy-001',
            },
          })

          expect(response.status).toBeGreaterThanOrEqual(200)
          expect(response.status).toBeLessThan(300)
          expect(capturedArgs).not.toBeNull()

          // wrkf transition.apply does not accept these fields
          expect(capturedArgs!['evidenceRefs']).toBeUndefined()
          expect(capturedArgs!['waiverRefs']).toBeUndefined()
          expect(capturedArgs!['inlineEvidence']).toBeUndefined()
          expect(capturedArgs!['runId']).toBeUndefined()
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
  })

  // ── 2b. wrkf error → HTTP status mapping ────────────────────────────────────
  //
  // RED because: current handler uses kernel; kernel errors have different codes
  // than wrkf errors. The handler does not call wrkfErrorToHttpStatus.
  //
  describe('wrkf error → HTTP status mapping (RED: kernel errors, not wrkf error codes)', () => {
    const ERROR_TABLE: Array<[wrkfCode: string, expectedHttp: number]> = [
      ['WRKF_STALE_REVISION', 409],
      ['WRKF_CONTEXT_MISMATCH', 409],
      ['WRKF_ROLE_DENIED', 403],
      ['WRKF_IDEMPOTENCY_MISMATCH', 409],
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

  // ── 2c. reconcileWorkflowEffectIntents must NOT be called after transition ───
  //
  // RED because: current handler calls reconcileEffects(deps) after applying the
  // transition, which in turn calls reconcileWorkflowEffectIntents.
  //
  describe('old reconciler not called post-transition (RED: current handler calls reconcileEffects)', () => {
    test('handleApplyWorkflowTransition source does not call reconcileWorkflowEffectIntents or reconcileEffects', () => {
      const src = readFileSync(new URL('../handlers/workflow-tasks.ts', import.meta.url), 'utf-8')
      const start = src.indexOf('export const handleApplyWorkflowTransition')
      expect(start).toBeGreaterThan(-1)
      const nextExport = src.indexOf('\nexport const handle', start + 1)
      const body = nextExport === -1 ? src.slice(start) : src.slice(start, nextExport)
      // After W3 impl: the old reconciler call must be gone from this handler.
      // Other handlers in the file may still use it for now (that's W5's job).
      expect(body).not.toContain('reconcileWorkflowEffectIntents')
      expect(body).not.toContain('reconcileEffects(')
    })
  })

  // ── 2d. deps.wrkf undefined → 503 WRKF_UNAVAILABLE ─────────────────────────
  //
  // RED because: current handler ignores deps.wrkf → kernel path → task_not_found → 422.
  //
  describe('deps.wrkf undefined guard (RED: current handler ignores wrkf, kernel → 422)', () => {
    test('POST /transitions without deps.wrkf returns 503 WRKF_UNAVAILABLE', async () => {
      await withWiredServer(async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/tasks/${TASK_ID}/transitions`,
          body: VALID_TRANSITION_BODY,
        })
        expect(response.status).toBe(503)
        const body = await fixture.json<{ error: { code: string } }>(response)
        expect(body.error.code).toBe('WRKF_UNAVAILABLE')
      })
    })
  })

  // ── 2e. Source: handleApplyWorkflowTransition must not use withDurableWorkflowKernel
  //
  // RED because: current handler calls withDurableWorkflowKernel.
  //
  describe('handler source does not use withDurableWorkflowKernel (RED: currently calls it)', () => {
    test('handleApplyWorkflowTransition function body does not contain withDurableWorkflowKernel', () => {
      const src = readFileSync(new URL('../handlers/workflow-tasks.ts', import.meta.url), 'utf-8')
      const start = src.indexOf('export const handleApplyWorkflowTransition')
      expect(start).toBeGreaterThan(-1)
      const nextExport = src.indexOf('\nexport const handle', start + 1)
      const body = nextExport === -1 ? src.slice(start) : src.slice(start, nextExport)
      expect(body).not.toContain('withDurableWorkflowKernel')
    })
  })
})

// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║  3. handleWaiveWorkflowObligation → deps.wrkf.obligation.waive             ║
// ╚══════════════════════════════════════════════════════════════════════════════╝

describe('W3: POST /v1/tasks/:taskId/obligations/:obligationId/waive — obligation.waive wrkf facade', () => {
  // ── 3a. obligation.waive is called directly without ACP pre-check ────────────
  //
  // RED because: current handler calls kernel.listObligations(taskId) first as a
  // pre-existence check. If the obligation is absent (it will be in an empty kernel
  // state), the handler returns obligation_not_found (422) before ever calling
  // deps.wrkf.obligation.waive. capturedArgs remains null → RED.
  //
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

    test('obligation.waive is called even when the obligation is not in ACP kernel state (wrkf is authority)', async () => {
      // This is the critical "no pre-check" invariant: the impl must NOT call
      // kernel.listObligations before delegating to wrkf. If it does, obligation
      // waiverWasCalled will be false because the pre-check short-circuits.
      let obligationWaiverWasCalled = false

      await withWiredServer(
        async (fixture) => {
          // OB-DOES-NOT-EXIST is not in the ACP kernel's obligation list.
          // Current handler: listObligations returns [] → returns obligation_not_found → 422.
          // New handler: calls obligation.waive directly → wrkf handles it.
          const response = await fixture.request({
            method: 'POST',
            path: `/v1/tasks/${TASK_ID}/obligations/OB-DOES-NOT-EXIST/waive`,
            body: { reason: 'wrkf decides existence' },
          })

          // The spy must have been called regardless of whether the obligation
          // exists in the ACP kernel's view.
          expect(obligationWaiverWasCalled).toBe(true)

          // Handler returns whatever wrkf returned (2xx in this fake)
          expect(response.status).toBeGreaterThanOrEqual(200)
          expect(response.status).toBeLessThan(300)
        },
        {
          wrkf: makeFakeWrkfPort({
            obligationWaive: async (_params) => {
              obligationWaiverWasCalled = true
              return CANNED_OBLIGATION_WAIVE_RESULT
            },
          }),
        }
      )
    })
  })

  // ── 3b. deps.wrkf undefined → 503 WRKF_UNAVAILABLE ─────────────────────────
  //
  // RED because: current handler ignores deps.wrkf → kernel pre-check → 422.
  //
  describe('deps.wrkf undefined guard (RED: current handler ignores wrkf, kernel → 422)', () => {
    test('POST /obligations/:id/waive without deps.wrkf returns 503 WRKF_UNAVAILABLE', async () => {
      await withWiredServer(async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/tasks/${TASK_ID}/obligations/${OBLIGATION_ID}/waive`,
          body: { reason: 'test' },
        })
        expect(response.status).toBe(503)
        const body = await fixture.json<{ error: { code: string } }>(response)
        expect(body.error.code).toBe('WRKF_UNAVAILABLE')
      })
    })
  })

  // ── 3c. Source: handleWaiveWorkflowObligation must not use withDurableWorkflowKernel
  //
  // RED because: current handler calls withDurableWorkflowKernel.
  //
  describe('handler source does not use withDurableWorkflowKernel (RED: currently calls it)', () => {
    test('handleWaiveWorkflowObligation function body does not contain withDurableWorkflowKernel', () => {
      const src = readFileSync(new URL('../handlers/workflow-tasks.ts', import.meta.url), 'utf-8')
      const start = src.indexOf('export const handleWaiveWorkflowObligation')
      expect(start).toBeGreaterThan(-1)
      const nextExport = src.indexOf('\nexport const handle', start + 1)
      const body = nextExport === -1 ? src.slice(start) : src.slice(start, nextExport)
      expect(body).not.toContain('withDurableWorkflowKernel')
    })
  })
})

// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║  4. handleCancelWorkflowObligation → deps.wrkf.obligation.cancel           ║
// ╚══════════════════════════════════════════════════════════════════════════════╝

describe('W3: POST /v1/tasks/:taskId/obligations/:obligationId/cancel — obligation.cancel wrkf facade', () => {
  // ── 4a. obligation.cancel is called directly without ACP pre-check ───────────
  //
  // RED because: current handler calls kernel.listObligations(taskId) first.
  // If the obligation is absent, the handler returns obligation_not_found (422)
  // before ever calling deps.wrkf.obligation.cancel. capturedArgs remains null.
  //
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

    test('obligation.cancel is called even when the obligation is not in ACP kernel state (wrkf is authority)', async () => {
      let obligationCancelWasCalled = false

      await withWiredServer(
        async (fixture) => {
          // OB-DOES-NOT-EXIST is not in the ACP kernel's obligation list.
          // Current handler: listObligations returns [] → obligation_not_found → 422.
          // New handler: calls obligation.cancel directly → wrkf decides.
          const response = await fixture.request({
            method: 'POST',
            path: `/v1/tasks/${TASK_ID}/obligations/OB-DOES-NOT-EXIST/cancel`,
            body: { reason: 'wrkf decides existence' },
          })

          expect(obligationCancelWasCalled).toBe(true)

          expect(response.status).toBeGreaterThanOrEqual(200)
          expect(response.status).toBeLessThan(300)
        },
        {
          wrkf: makeFakeWrkfPort({
            obligationCancel: async (_params) => {
              obligationCancelWasCalled = true
              return CANNED_OBLIGATION_CANCEL_RESULT
            },
          }),
        }
      )
    })
  })

  // ── 4b. deps.wrkf undefined → 503 WRKF_UNAVAILABLE ─────────────────────────
  //
  // RED because: current handler ignores deps.wrkf → kernel pre-check → 422.
  //
  describe('deps.wrkf undefined guard (RED: current handler ignores wrkf, kernel → 422)', () => {
    test('POST /obligations/:id/cancel without deps.wrkf returns 503 WRKF_UNAVAILABLE', async () => {
      await withWiredServer(async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/tasks/${TASK_ID}/obligations/${OBLIGATION_ID}/cancel`,
          body: { reason: 'test' },
        })
        expect(response.status).toBe(503)
        const body = await fixture.json<{ error: { code: string } }>(response)
        expect(body.error.code).toBe('WRKF_UNAVAILABLE')
      })
    })
  })

  // ── 4c. Source: handleCancelWorkflowObligation must not use withDurableWorkflowKernel
  //
  // RED because: current handler calls withDurableWorkflowKernel.
  //
  describe('handler source does not use withDurableWorkflowKernel (RED: currently calls it)', () => {
    test('handleCancelWorkflowObligation function body does not contain withDurableWorkflowKernel', () => {
      const src = readFileSync(new URL('../handlers/workflow-tasks.ts', import.meta.url), 'utf-8')
      const start = src.indexOf('export const handleCancelWorkflowObligation')
      expect(start).toBeGreaterThan(-1)
      // handleCancelWorkflowObligation is the last handler in the file — no next export
      const nextExport = src.indexOf('\nexport const handle', start + 1)
      const body = nextExport === -1 ? src.slice(start) : src.slice(start, nextExport)
      expect(body).not.toContain('withDurableWorkflowKernel')
    })
  })
})
