/**
 * RED TESTS - Phase 6: Gate /v1/wrkf/pbc/* debug routes behind operator auth (T-02938)
 *
 * These tests prove the debug routes are gated by injected authorization policy:
 *
 *   1. GET /v1/wrkf/pbc/tasks/:task/inspect must call authorize with
 *      operation 'wrkf.pbc.inspect'.
 *
 *   2. POST debug routes keep the current 'wrkf.pbc.*' and 'wrkf.effects.deliver'
 *      operation names. There is no built-in operator role; deployments enforce
 *      operator/debug access by denying these operation strings in deps.authorize.
 *
 * ---------------------------------------------------------------------------
 * IMPL CONTRACT - what larry must do to turn these tests GREEN
 *
 * 1. Add GET inspect to the route authz specs:
 *      'GET /v1/wrkf/pbc/tasks/:task/inspect' -> { operation: 'wrkf.pbc.inspect',
 *                                                  resource: { kind: 'wrkf-task' } }
 *
 * 2. Wrap GET /v1/wrkf/pbc/tasks/:task/inspect with withActorAndAuthz in
 *    routing/param-routes.ts using withSpec, just as POST routes are wrapped.
 *
 * 3. /v1/pbc/* product route operations remain in the 'pbc.tasks.*' namespace - UNCHANGED.
 *
 * Canonical forbidden response: HTTP 403 { error: { code: 'authz_deny', message: 'forbidden' } }
 * ---------------------------------------------------------------------------
 */

import { describe, expect, test } from 'bun:test'

import { withWiredServer } from '../../test/fixtures/wired-server.js'
import type { AuthorizeFn } from '../deps.js'
import type { AcpWrkfWorkflowPort } from '../wrkf/port.js'

// Constants

const TASK = 'T-02938-p6'
const IDEMPOTENCY_KEY = 'p6-operator-gate-test-001'

// Debug-route authorize function

/**
 * A deployment-style operator gate implemented as an injected authorize policy.
 *
 * The product has no internal operator role. These tests model one possible
 * deployment policy: deny wrkf debug operations to non-system actors and allow
 * all other operations.
 */
const DEBUG_OPERATIONS: ReadonlySet<string> = new Set([
  'wrkf.pbc.inspect',
  'wrkf.pbc.run-step',
  'wrkf.pbc.approve-transition',
  'wrkf.pbc.run-until-blocked',
  'wrkf.effects.deliver',
])

const operatorOnlyAuthorize: AuthorizeFn = (actor, operation) =>
  DEBUG_OPERATIONS.has(operation) ? (actor.kind === 'system' ? 'allow' : 'deny') : 'allow'

// Actor fixtures

/** Non-operator in this test policy: agent kind is denied for wrkf debug operations. */
const NON_OPERATOR_ACTOR = { kind: 'agent' as const, id: 'product-client' }

// Operator is the default system actor (kind: 'system', id: 'acp-local')
// set by resolveAcpServerDeps when no defaultActor override is provided.

const NON_OPERATOR_OPTS = {
  defaultActor: NON_OPERATOR_ACTOR,
  authorize: operatorOnlyAuthorize,
} as const

// Minimal wrkf fake port

function makeMinimalWrkfPort(): AcpWrkfWorkflowPort {
  const boom =
    (name: string) =>
    (): never => {
      throw new Error(`minimal wrkf port: '${name}' must not be called in this scenario`)
    }

  return {
    workflow: {
      validate: boom('workflow.validate'),
      show: boom('workflow.show'),
      list: boom('workflow.list'),
      diff: boom('workflow.diff'),
      install: boom('workflow.install'),
    },
    task: {
      attach: async (params) => ({
        task: (params as Record<string, unknown>)['task'],
        workflowRef: 'pbc-progressive-refinement@5',
      }),
      inspect: async (params) => ({
        task: { taskId: (params as Record<string, unknown>)['task'] },
      }),
      timeline: boom('task.timeline'),
      refresh: boom('task.refresh'),
      syncMeta: boom('task.syncMeta'),
    },
    next: async () => ({
      instance: {
        id: 'inst-p6-test',
        state: { status: 'active', phase: 'behavior_note' },
        revision: 1,
        contextHash: 'ctx-p6-test',
      },
      actions: [],
      blockedTransitions: [],
      openObligations: [],
      pendingEffects: [],
    }),
    evidence: {
      add: async () => ({ id: 'ev-p6-test', kind: 'result', task: TASK }),
      list: async () => [],
      show: boom('evidence.show'),
      suggest: boom('evidence.suggest'),
    },
    obligation: {
      list: async () => [],
      show: boom('obligation.show'),
      satisfy: async () => ({}),
      waive: boom('obligation.waive'),
      cancel: boom('obligation.cancel'),
    },
    transition: {
      apply: async () => ({ task: TASK, transition: 'test_transition', revision: 2 }),
    },
    run: {
      start: async () => ({ id: 'run-p6-test', task: TASK, role: 'agent', state: 'active' }),
      bindExternal: boom('run.bindExternal'),
      finish: async () => ({ id: 'run-p6-test', state: 'completed', terminalResult: 'done' }),
      fail: async () => ({ id: 'run-p6-test', state: 'failed' }),
      show: boom('run.show'),
      list: boom('run.list'),
    },
    effect: {
      list: async () => [],
      show: boom('effect.show'),
      claim: boom('effect.claim'),
      ack: boom('effect.ack'),
      fail: boom('effect.fail'),
      retry: boom('effect.retry'),
      deliver: async () => ({ status: 'delivered' }),
    },
  } as AcpWrkfWorkflowPort
}

// ---------------------------------------------------------------------------
// Section 1 - Non-operator actor receives 403 on all wrkf debug routes under this policy.
// ---------------------------------------------------------------------------

describe('/v1/wrkf/pbc/* operator gate - non-operator gets 403 (RED)', () => {
  test('[RED] GET /v1/wrkf/pbc/tasks/:task/inspect -> 403 for non-operator actor', async () => {
    // The injected policy denies 'wrkf.pbc.inspect' for this actor.
    const wrkf = makeMinimalWrkfPort()
    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'GET',
          path: `/v1/wrkf/pbc/tasks/${TASK}/inspect`,
        })
        expect(response.status).toBe(403)
        const body = await fixture.json<{ error: { code: string } }>(response)
        expect(body.error.code).toBe('authz_deny')
      },
      { wrkf, ...NON_OPERATOR_OPTS }
    )
  })

  test('[RED] POST /v1/wrkf/pbc/tasks/:task/run-step -> 403 for non-operator actor', async () => {
    // The injected policy denies 'wrkf.pbc.run-step' for this actor.
    const wrkf = makeMinimalWrkfPort()
    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/wrkf/pbc/tasks/${TASK}/run-step`,
          body: { idempotencyKey: `${IDEMPOTENCY_KEY}-run-step` },
        })
        expect(response.status).toBe(403)
        const body = await fixture.json<{ error: { code: string } }>(response)
        expect(body.error.code).toBe('authz_deny')
      },
      { wrkf, ...NON_OPERATOR_OPTS }
    )
  })

  test('[RED] POST /v1/wrkf/pbc/tasks/:task/approve-transition -> 403 for non-operator actor', async () => {
    // The injected policy denies 'wrkf.pbc.approve-transition' for this actor.
    const wrkf = makeMinimalWrkfPort()
    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/wrkf/pbc/tasks/${TASK}/approve-transition`,
          body: {
            transition: 'complete_implementation',
            idempotencyKey: `${IDEMPOTENCY_KEY}-approve-transition`,
          },
        })
        expect(response.status).toBe(403)
        const body = await fixture.json<{ error: { code: string } }>(response)
        expect(body.error.code).toBe('authz_deny')
      },
      { wrkf, ...NON_OPERATOR_OPTS }
    )
  })

  test('[RED] POST /v1/wrkf/pbc/tasks/:task/run-until-blocked -> 403 for non-operator actor', async () => {
    // The injected policy denies 'wrkf.pbc.run-until-blocked' for this actor.
    const wrkf = makeMinimalWrkfPort()
    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/wrkf/pbc/tasks/${TASK}/run-until-blocked`,
          body: {
            idempotencyKey: `${IDEMPOTENCY_KEY}-run-until-blocked`,
            maxTurns: 1,
          },
        })
        expect(response.status).toBe(403)
        const body = await fixture.json<{ error: { code: string } }>(response)
        expect(body.error.code).toBe('authz_deny')
      },
      { wrkf, ...NON_OPERATOR_OPTS }
    )
  })

  test('[RED] POST /v1/wrkf/effects/deliver -> 403 for non-operator actor', async () => {
    // The injected policy denies 'wrkf.effects.deliver' for this actor.
    const wrkf = makeMinimalWrkfPort()
    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: '/v1/wrkf/effects/deliver',
          body: { task: TASK },
        })
        expect(response.status).toBe(403)
        const body = await fixture.json<{ error: { code: string } }>(response)
        expect(body.error.code).toBe('authz_deny')
      },
      { wrkf, ...NON_OPERATOR_OPTS }
    )
  })
})

// ---------------------------------------------------------------------------
// Section 2 - Operator actor (system kind) passes through on all /v1/wrkf/pbc/* routes
//      GREEN baseline: routes already work for operators; must stay GREEN after Phase 6
// ---------------------------------------------------------------------------

describe('/v1/wrkf/pbc/* operator gate - operator (system actor) passes (GREEN baseline)', () => {
  test('GET /v1/wrkf/pbc/tasks/:task/inspect - not 403 for system actor', async () => {
    // Default actor is { kind: 'system', id: 'acp-local' }.
    // The injected policy allows 'wrkf.pbc.inspect' for system actors.
    const wrkf = makeMinimalWrkfPort()
    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'GET',
          path: `/v1/wrkf/pbc/tasks/${TASK}/inspect`,
        })
        expect(response.status).not.toBe(403)
      },
      { wrkf, authorize: operatorOnlyAuthorize }
    )
  })

  test('POST /v1/wrkf/pbc/tasks/:task/run-step - not 403 for system actor', async () => {
    const wrkf = makeMinimalWrkfPort()
    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/wrkf/pbc/tasks/${TASK}/run-step`,
          body: { idempotencyKey: `${IDEMPOTENCY_KEY}-op-run-step` },
        })
        expect(response.status).not.toBe(403)
      },
      { wrkf, authorize: operatorOnlyAuthorize }
    )
  })

  test('POST /v1/wrkf/pbc/tasks/:task/approve-transition - not 403 for system actor', async () => {
    const wrkf = makeMinimalWrkfPort()
    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/wrkf/pbc/tasks/${TASK}/approve-transition`,
          body: {
            transition: 'complete_implementation',
            idempotencyKey: `${IDEMPOTENCY_KEY}-op-approve-transition`,
          },
        })
        expect(response.status).not.toBe(403)
      },
      { wrkf, authorize: operatorOnlyAuthorize }
    )
  })

  test('POST /v1/wrkf/pbc/tasks/:task/run-until-blocked - not 403 for system actor', async () => {
    const wrkf = makeMinimalWrkfPort()
    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/wrkf/pbc/tasks/${TASK}/run-until-blocked`,
          body: {
            idempotencyKey: `${IDEMPOTENCY_KEY}-op-run-until-blocked`,
            maxTurns: 1,
          },
        })
        expect(response.status).not.toBe(403)
      },
      { wrkf, authorize: operatorOnlyAuthorize }
    )
  })

  test('POST /v1/wrkf/effects/deliver - not 403 for system actor', async () => {
    const wrkf = makeMinimalWrkfPort()
    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: '/v1/wrkf/effects/deliver',
          body: { task: TASK },
        })
        expect(response.status).not.toBe(403)
      },
      { wrkf, authorize: operatorOnlyAuthorize }
    )
  })
})

// ---------------------------------------------------------------------------
// Section 3 - /v1/pbc/* product routes are UNAFFECTED by the operator gate
//      operatorOnlyAuthorize only gates wrkf debug operations;
//      product routes use 'pbc.tasks.*' -> always allowed for all actors.
//      GREEN baseline: must remain GREEN before and after Phase 6.
// ---------------------------------------------------------------------------

describe('/v1/pbc/* product routes - unaffected by debug operator gate (GREEN baseline)', () => {
  test('GET /v1/pbc/tasks/:taskId - non-operator actor is not blocked (read-only, no authz)', async () => {
    const wrkf = makeMinimalWrkfPort()
    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'GET',
          path: `/v1/pbc/tasks/${TASK}`,
        })
        // pbc.tasks GET is read-only; not in mutatingRouteSpecs -> no gate -> non-403
        expect(response.status).not.toBe(403)
      },
      { wrkf, ...NON_OPERATOR_OPTS }
    )
  })

  test('POST /v1/pbc/tasks/:taskId/start - non-operator actor is not blocked by debug gate', async () => {
    // Operation 'pbc.tasks.start' is NOT in DEBUG_OPERATIONS ->
    // operatorOnlyAuthorize returns 'allow' for non-system actors on this route.
    const wrkf = makeMinimalWrkfPort()
    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/start`,
          body: {
            idempotencyKey: `${IDEMPOTENCY_KEY}-pbc-start-unaffected`,
            intake: { title: 'Phase 6 unaffected PBC test' },
          },
        })
        // Non-operator (agent actor) on product route -> operatorOnlyAuthorize allows -> not 403
        expect(response.status).not.toBe(403)
      },
      { wrkf, ...NON_OPERATOR_OPTS }
    )
  })
})
