/**
 * Red tests — Phase 1, Deliverable 3:
 * POST /v1/tasks/:taskId/obligations/:obligationId/satisfy
 *
 * WHY RED NOW:
 *   The route `POST /v1/tasks/:taskId/obligations/:obligationId/satisfy` does not exist.
 *   The server returns 404 for all requests to this path.
 *
 * WHAT THE IMPL AGENT MUST ADD:
 *
 *   1. Handler: `handleSatisfyWorkflowObligation` in
 *      `packages/acp-server/src/handlers/workflow-tasks.ts`
 *      following the same pattern as handleWaiveWorkflowObligation:
 *        - Guard: deps.wrkf undefined → 503 WRKF_UNAVAILABLE
 *        - Parse body: requireRecord; optional evidenceId, actor, role, reason
 *        - Do NOT pre-check obligation existence via ACP obligation list (wrkf is authority)
 *        - Delegate: await wrkf.obligation.satisfy({ task, id, evidenceId?, actor?, role?, reason? })
 *        - Catch wrkf errors → wrkfErrorToHttpStatus
 *        - Return: json(result)
 *
 *   2. Register route in `packages/acp-server/src/routing/param-routes.ts`
 *      (adjacent to existing waive/cancel routes, ~lines 195-204):
 *        createParamRoute(
 *          'POST',
 *          '/v1/tasks/:taskId/obligations/:obligationId/satisfy',
 *          handleSatisfyWorkflowObligation
 *        ),
 *
 *   3. Import handleSatisfyWorkflowObligation in param-routes.ts
 *      (alongside handleWaiveWorkflowObligation, handleCancelWorkflowObligation).
 *
 * Pattern mirrors: handleWaiveWorkflowObligation / handleCancelWorkflowObligation.
 */

import { describe, expect, test } from 'bun:test'

import { withWiredServer } from '../../test/fixtures/wired-server.js'
import type { AcpWrkfWorkflowPort } from '../wrkf/port.js'

// ── Constants ─────────────────────────────────────────────────────────────────

const TASK_ID = 'T-P1D3-001'
const OBLIGATION_ID = 'OB-P1D3-001'

// ── Helpers ───────────────────────────────────────────────────────────────────

class WrkfError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'WrkfError'
  }
}

const CANNED_SATISFY_RESULT = {
  task: { taskId: TASK_ID },
  obligation: { id: OBLIGATION_ID, status: 'satisfied' },
}

function makeFakeWrkfPort(
  overrides: {
    obligationSatisfy?: ((params: Record<string, unknown>) => Promise<unknown>) | undefined
  } = {}
): AcpWrkfWorkflowPort {
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
      add: notCalled('evidence.add'),
      list: notCalled('evidence.list'),
      show: notCalled('evidence.show'),
      suggest: notCalled('evidence.suggest'),
    },
    obligation: {
      list: notCalled('obligation.list'),
      show: notCalled('obligation.show'),
      satisfy: overrides.obligationSatisfy ?? (async (_params) => CANNED_SATISFY_RESULT),
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
// ║  1. Route exists and delegates to wrkf.obligation.satisfy                   ║
// ╚══════════════════════════════════════════════════════════════════════════════╝

describe('P1-D3: POST /v1/tasks/:taskId/obligations/:obligationId/satisfy — route exists', () => {
  test('obligation.satisfy is called with task and id (obligationId) — no pre-check', async () => {
    let capturedArgs: Record<string, unknown> | null = null

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/tasks/${TASK_ID}/obligations/${OBLIGATION_ID}/satisfy`,
          body: {
            actor: { agentId: 'test-agent' },
            role: 'owner',
          },
        })

        // RED: route doesn't exist → 404, satisfy never called
        expect(response.status).toBeGreaterThanOrEqual(200)
        expect(response.status).toBeLessThan(300)
        expect(capturedArgs).not.toBeNull()
        expect(capturedArgs!['task']).toBe(TASK_ID)
        expect(capturedArgs!['id']).toBe(OBLIGATION_ID)
      },
      {
        wrkf: makeFakeWrkfPort({
          obligationSatisfy: async (params) => {
            capturedArgs = params as Record<string, unknown>
            return CANNED_SATISFY_RESULT
          },
        }),
      }
    )
  })
})

// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║  2. Optional params forwarded: evidenceId, actor, role, reason              ║
// ╚══════════════════════════════════════════════════════════════════════════════╝

describe('P1-D3: POST satisfy — optional params forwarded to wrkf.obligation.satisfy', () => {
  test('evidenceId is forwarded when provided', async () => {
    let capturedArgs: Record<string, unknown> | null = null

    await withWiredServer(
      async (fixture) => {
        await fixture.request({
          method: 'POST',
          path: `/v1/tasks/${TASK_ID}/obligations/${OBLIGATION_ID}/satisfy`,
          body: {
            evidenceId: 'ev_abc123',
            actor: { agentId: 'test-agent' },
            role: 'assessor',
            reason: 'obligation met by evidence ev_abc123',
          },
        })
        // RED: route doesn't exist
        expect(capturedArgs).not.toBeNull()
        expect(capturedArgs!['evidenceId']).toBe('ev_abc123')
        expect(capturedArgs!['principal_ref']).toBe('agent:test-agent')
        expect(capturedArgs!['role']).toBe('assessor')
        expect(capturedArgs!['reason']).toBe('obligation met by evidence ev_abc123')
      },
      {
        wrkf: makeFakeWrkfPort({
          obligationSatisfy: async (params) => {
            capturedArgs = params as Record<string, unknown>
            return CANNED_SATISFY_RESULT
          },
        }),
      }
    )
  })

  test('satisfy called with task + id only when no optional params provided', async () => {
    let capturedArgs: Record<string, unknown> | null = null

    await withWiredServer(
      async (fixture) => {
        await fixture.request({
          method: 'POST',
          path: `/v1/tasks/${TASK_ID}/obligations/${OBLIGATION_ID}/satisfy`,
          body: {},
        })
        // RED: route doesn't exist
        expect(capturedArgs).not.toBeNull()
        expect(capturedArgs!['task']).toBe(TASK_ID)
        expect(capturedArgs!['id']).toBe(OBLIGATION_ID)
        // optional fields absent from params (not present as undefined)
        expect(capturedArgs!['evidenceId']).toBeUndefined()
      },
      {
        wrkf: makeFakeWrkfPort({
          obligationSatisfy: async (params) => {
            capturedArgs = params as Record<string, unknown>
            return CANNED_SATISFY_RESULT
          },
        }),
      }
    )
  })
})

// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║  3. Error handling                                                          ║
// ╚══════════════════════════════════════════════════════════════════════════════╝

describe('P1-D3: POST satisfy — error handling', () => {
  test.each([
    { code: 'WRKF_NOT_FOUND', status: 404, role: undefined },
    { code: 'WRKF_ROLE_DENIED', status: 403, role: 'wrong-role' },
    { code: 'WRKF_VALIDATION', status: 422, role: undefined },
  ])('$code from satisfy maps to $status', async ({ code, status, role }) => {
    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/tasks/${TASK_ID}/obligations/${OBLIGATION_ID}/satisfy`,
          body: { actor: { agentId: 'test-agent' }, role },
        })
        expect(response.status).toBe(status)
        const body = await fixture.json<{ error: { code: string } }>(response)
        expect(body.error.code).toBe(code)
      },
      {
        wrkf: makeFakeWrkfPort({
          obligationSatisfy: async () => {
            throw new WrkfError(code, 'satisfy failed')
          },
        }),
      }
    )
  })
})
