/**
 * RED TESTS — PBC harness Phase 6: HTTP routes + idempotency persistence + authz (T-02037)
 *
 * Tests are RED because:
 *   1. None of the routes are registered in param-routes.ts / exact-routes.ts
 *      → server returns 404 for all 5 paths.
 *   2. Handler files (handlers/wrkf-pbc-*.ts) do not exist yet.
 *   3. Idempotency store persistence is not implemented.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IMPL CONTRACT — what larry must create to go green
 *
 * FILE: packages/acp-server/src/handlers/wrkf-pbc-inspect.ts
 *   export const handleWrkfPbcInspect: RouteHandler
 *   - GET /v1/wrkf/pbc/tasks/:task/inspect
 *   - Returns 503 WRKF_UNAVAILABLE if deps.wrkf === undefined
 *   - Calls wrkf.next({task: params.task, role: 'agent'}) (read-only)
 *   - Returns 200 with {task, workflowRef, instance, next, ...} projection
 *   - Maps wrkf errors → wrkfErrorToHttpStatus(code)
 *   - MUST NOT call wrkf.run.start / evidence.add / transition.apply (read-only)
 *
 * FILE: packages/acp-server/src/handlers/wrkf-pbc-run-step.ts
 *   export const handleWrkfPbcRunStep: RouteHandler
 *   - POST /v1/wrkf/pbc/tasks/:task/run-step
 *   - Body: { role?, actor, idempotencyKey, launchRuntime?, participantOutput?, transitionPolicy? }
 *   - Returns 400 if idempotencyKey is absent
 *   - Computes SHA-256 (or stable JSON hash) of the raw request body
 *   - Checks PbcRouteIdempotencyStore BEFORE calling runStep():
 *       same idempotencyKey + same bodyHash  → 200 with prior result (no wrkf calls)
 *       same idempotencyKey + diff bodyHash  → 409 code=IDEMPOTENCY_MISMATCH
 *       fresh                                → call runStep(), then persist
 *   - Delegates to runStep(deps.wrkf, { task: params.task, ...body })
 *   - Returns 200 with PbcHarnessResult
 *   - Must be in mutatingRouteSpecs ('POST /v1/wrkf/pbc/tasks/:task/run-step')
 *
 * FILE: packages/acp-server/src/handlers/wrkf-pbc-approve-transition.ts
 *   export const handleWrkfPbcApproveTransition: RouteHandler
 *   - POST /v1/wrkf/pbc/tasks/:task/approve-transition
 *   - Body: { transition, role?, actor, idempotencyKey, runChecks? }
 *   - Same idempotency check as run-step
 *   - Delegates to approveTransition(deps.wrkf, { task: params.task, routeKey: idempotencyKey, ...body })
 *   - Returns 200 with PbcHarnessResult
 *   - Must be in mutatingRouteSpecs
 *
 * FILE: packages/acp-server/src/handlers/wrkf-pbc-run-until-blocked.ts
 *   export const handleWrkfPbcRunUntilBlocked: RouteHandler
 *   - POST /v1/wrkf/pbc/tasks/:task/run-until-blocked
 *   - Body: { actor, pressureActor?, productOwnerActor?, idempotencyKey, maxTurns?,
 *             allowDisposition?, allowProductOwnerSimulation? }
 *   - Same idempotency check as run-step
 *   - Delegates to runUntilBlocked(deps.wrkf, { task: params.task, ...body })
 *   - Returns 200 with PbcHarnessResult containing stopReason
 *   - Must be in mutatingRouteSpecs
 *
 * FILE: packages/acp-server/src/handlers/wrkf-pbc-deliver-effects.ts
 *   export const handleWrkfPbcDeliverEffects: RouteHandler
 *   - POST /v1/wrkf/effects/deliver (exact route — no :task param)
 *   - Body: { task?, effectId?, adapter?, maxEffects? }
 *   - Calls effect.list({task: body.task}) to get pending effects
 *   - Calls effect.deliver({effectId, adapter}) for each pending effect
 *   - NEVER passes task to effect.deliver (task? is server-ignored there)
 *   - Returns 200 with {task?, delivered: string[], skipped: {...}[]}
 *   - Must be in mutatingRouteSpecs
 *
 * IDEMPOTENCY STORE INTERFACE (packages/acp-server/src/wrkf/pbc-route-idempotency-store.ts):
 *
 *   export interface PbcRouteIdempotencyStore {
 *     check(key: string, bodyHash: string): Promise<
 *       | { state: 'fresh' }
 *       | { state: 'replay'; result: unknown }
 *       | { state: 'conflict' }
 *     >
 *     persist(key: string, bodyHash: string, result: unknown): Promise<void>
 *   }
 *
 *   export class InMemoryPbcIdempotencyStore implements PbcRouteIdempotencyStore {
 *     // in-memory Map<key, {bodyHash, result}>
 *   }
 *
 *   The store MUST be injected via deps (e.g. deps.pbcIdempotencyStore?:
 *   PbcRouteIdempotencyStore), with InMemoryPbcIdempotencyStore as the default.
 *   Handlers compute bodyHash as a SHA-256 hex digest of JSON.stringify(parsedBody),
 *   OR use a stable sorted-key serialization (stableStringify).
 *
 * ROUTE WIRING (routing/param-routes.ts + routing/exact-routes.ts):
 *   createParamRoute('GET',  '/v1/wrkf/pbc/tasks/:task/inspect',
 *                    handleWrkfPbcInspect)
 *   createParamRoute('POST', '/v1/wrkf/pbc/tasks/:task/run-step',
 *                    withSpec('POST', '/v1/wrkf/pbc/tasks/:task/run-step', handleWrkfPbcRunStep))
 *   createParamRoute('POST', '/v1/wrkf/pbc/tasks/:task/approve-transition',
 *                    withSpec(..., handleWrkfPbcApproveTransition))
 *   createParamRoute('POST', '/v1/wrkf/pbc/tasks/:task/run-until-blocked',
 *                    withSpec(..., handleWrkfPbcRunUntilBlocked))
 *   exactRouteKey('POST', '/v1/wrkf/effects/deliver'):
 *     maybeWrapMutatingRoute('POST', '/v1/wrkf/effects/deliver', handleWrkfPbcDeliverEffects)
 *
 * mutatingRouteSpecs additions (routing/mutating-routes.ts):
 *   'POST /v1/wrkf/pbc/tasks/:task/run-step'        → operation: 'wrkf.pbc.run-step'
 *   'POST /v1/wrkf/pbc/tasks/:task/approve-transition' → operation: 'wrkf.pbc.approve-transition'
 *   'POST /v1/wrkf/pbc/tasks/:task/run-until-blocked'  → operation: 'wrkf.pbc.run-until-blocked'
 *   'POST /v1/wrkf/effects/deliver'                    → operation: 'wrkf.effects.deliver'
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { describe, expect, test } from 'bun:test'

import { withWiredServer } from '../../test/fixtures/wired-server.js'
import type { AcpWrkfWorkflowPort } from '../wrkf/port.js'

// ─── Shared fixture data ─────────────────────────────────────────────────────

const TASK = 'T-02099'
const ACTOR = 'larry'
const IDEMPOTENCY_KEY = 'pbc-route-test-001'

// Minimal wrkf next response shape
const CANNED_NEXT = {
  instance: {
    state: { status: 'in_progress', phase: 'implementation' },
    revision: 7,
    contextHash: 'ctx-hash-abc',
  },
  actions: [{ transition: 'complete_implementation', role: 'implementer' }],
  blockedTransitions: [],
  openObligations: [],
  pendingEffects: [],
}

const CANNED_RUN = { id: 'wrkfrun-pbc-001', task: TASK, role: 'agent', state: 'active' }

const CANNED_FINISH = { id: 'wrkfrun-pbc-001', state: 'completed', terminalResult: 'done' }

const CANNED_EFFECTS = [
  { id: 'eff-aaa', kind: 'set_task_state', status: 'pending' },
  { id: 'eff-bbb', kind: 'set_task_state', status: 'pending' },
]

/** Typed wrkf error for error-mapping tests */
class WrkfError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'WrkfError'
  }
}

// ─── Fake port builder ───────────────────────────────────────────────────────

type WrkfPortCall = { method: string; params: unknown }

type FakePbcPortOverrides = {
  next?: () => Promise<unknown>
  runStart?: () => Promise<unknown>
  runFinish?: () => Promise<unknown>
  runFail?: () => Promise<unknown>
  evidenceAdd?: () => Promise<unknown>
  transitionApply?: () => Promise<unknown>
  effectList?: () => Promise<unknown>
  effectDeliver?: () => Promise<unknown>
  taskInspect?: () => Promise<unknown>
  capturesGet?: () => Promise<unknown>
}

type InstrumentedPort = AcpWrkfWorkflowPort & {
  _calls: WrkfPortCall[]
  captures: {
    get(key: string): Promise<unknown>
    set(key: string, record: unknown): Promise<void>
  }
}

function makeFakePbcPort(overrides: FakePbcPortOverrides = {}): InstrumentedPort {
  const _calls: WrkfPortCall[] = []
  const captureStore = new Map<string, unknown>()
  const boom = (name: string) => (): never => {
    throw new Error(`fake wrkf: ${name} must not be called in this scenario`)
  }

  const port: InstrumentedPort = {
    _calls,

    captures: {
      async get(key: string) {
        _calls.push({ method: 'captures.get', params: { key } })
        if (overrides.capturesGet !== undefined) return overrides.capturesGet()
        return captureStore.get(key)
      },
      async set(key: string, record: unknown) {
        _calls.push({ method: 'captures.set', params: { key } })
        captureStore.set(key, record)
      },
    },

    workflow: {
      validate: boom('workflow.validate'),
      show: boom('workflow.show'),
      list: boom('workflow.list'),
      diff: boom('workflow.diff'),
      install: boom('workflow.install'),
    },

    task: {
      attach: boom('task.attach'),
      inspect: async (params) => {
        _calls.push({ method: 'task.inspect', params })
        if (overrides.taskInspect !== undefined) return overrides.taskInspect()
        return { task: { taskId: TASK }, instance: CANNED_NEXT.instance }
      },
      timeline: boom('task.timeline'),
      refresh: boom('task.refresh'),
      syncMeta: boom('task.syncMeta'),
    },

    next: async (params) => {
      _calls.push({ method: 'next', params })
      if (overrides.next !== undefined) return overrides.next()
      return CANNED_NEXT
    },

    evidence: {
      add: async (params) => {
        _calls.push({ method: 'evidence.add', params })
        if (overrides.evidenceAdd !== undefined) return overrides.evidenceAdd()
        return { id: `ev-${Date.now()}`, kind: 'result', task: TASK }
      },
      list: boom('evidence.list'),
      show: boom('evidence.show'),
      suggest: boom('evidence.suggest'),
    },

    obligation: {
      list: async (params) => {
        _calls.push({ method: 'obligation.list', params })
        return []
      },
      show: boom('obligation.show'),
      satisfy: async (params) => {
        _calls.push({ method: 'obligation.satisfy', params })
        return {}
      },
      waive: boom('obligation.waive'),
      cancel: boom('obligation.cancel'),
    },

    transition: {
      apply: async (params) => {
        _calls.push({ method: 'transition.apply', params })
        if (overrides.transitionApply !== undefined) return overrides.transitionApply()
        return { task: TASK, transition: 'complete_implementation', revision: 8 }
      },
    },

    run: {
      start: async (params) => {
        _calls.push({ method: 'run.start', params })
        if (overrides.runStart !== undefined) return overrides.runStart()
        return CANNED_RUN
      },
      bindExternal: boom('run.bindExternal'),
      finish: async (params) => {
        _calls.push({ method: 'run.finish', params })
        if (overrides.runFinish !== undefined) return overrides.runFinish()
        return CANNED_FINISH
      },
      fail: async (params) => {
        _calls.push({ method: 'run.fail', params })
        if (overrides.runFail !== undefined) return overrides.runFail()
        return { id: CANNED_RUN.id, state: 'failed' }
      },
      show: boom('run.show'),
      list: boom('run.list'),
    },

    effect: {
      list: async (params) => {
        _calls.push({ method: 'effect.list', params })
        if (overrides.effectList !== undefined) return overrides.effectList()
        return CANNED_EFFECTS
      },
      show: boom('effect.show'),
      claim: boom('effect.claim'),
      ack: boom('effect.ack'),
      fail: boom('effect.fail'),
      retry: boom('effect.retry'),
      deliver: async (params) => {
        _calls.push({ method: 'effect.deliver', params })
        if (overrides.effectDeliver !== undefined) return overrides.effectDeliver()
        return { effectId: (params as Record<string, unknown>)['effectId'], status: 'delivered' }
      },
    },
  } as InstrumentedPort

  return port
}

// ─────────────────────────────────────────────────────────────────────────────
// §1 — GET /v1/wrkf/pbc/tasks/:task/inspect
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /v1/wrkf/pbc/tasks/:task/inspect — read-only inspection (RED)', () => {
  // RED: route not registered → server returns 404.

  test('[RED] returns 200 with wrkf projection on successful inspect', async () => {
    const wrkf = makeFakePbcPort()

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'GET',
          path: `/v1/wrkf/pbc/tasks/${TASK}/inspect`,
        })

        // RED: route not registered → 404; handler not implemented
        expect(response.status).toBe(200)
        const body = await fixture.json<Record<string, unknown>>(response)
        expect(body['task']).toBeDefined()
        expect(body['workflowRef']).toBe('pbc-progressive-refinement@9')
        expect(body['instance']).toBeDefined()
        expect(body['next']).toBeDefined()
      },
      { wrkf }
    )
  })

  test('[RED] inspect translates :task param to wrkf `task` field (never taskId)', async () => {
    const SPECIFIC_TASK = 'T-98765'
    const wrkf = makeFakePbcPort()

    await withWiredServer(
      async (fixture) => {
        await fixture.request({
          method: 'GET',
          path: `/v1/wrkf/pbc/tasks/${SPECIFIC_TASK}/inspect`,
        })

        // The wrkf call must use `task`, NOT `taskId`
        const nextCall = wrkf._calls.find((c) => c.method === 'next')
        expect(nextCall).toBeDefined()
        const p = nextCall!.params as Record<string, unknown>
        expect(p['task']).toBe(SPECIFIC_TASK)
        expect(p['taskId']).toBeUndefined()
      },
      { wrkf }
    )
  })

  test('[RED] inspect MUST NOT call evidence.add, transition.apply, or run.start (read-only)', async () => {
    const wrkf = makeFakePbcPort()

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'GET',
          path: `/v1/wrkf/pbc/tasks/${TASK}/inspect`,
        })

        // RED: route not registered → 404; handler must return 200 and call only read methods
        expect(response.status).toBe(200)

        const writeCalls = wrkf._calls.filter((c) =>
          ['evidence.add', 'transition.apply', 'run.start', 'run.finish', 'run.fail'].includes(
            c.method
          )
        )
        expect(writeCalls).toHaveLength(0)
      },
      { wrkf }
    )
  })

  test('[RED] returns 503 WRKF_UNAVAILABLE when deps.wrkf is absent', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request({
        method: 'GET',
        path: `/v1/wrkf/pbc/tasks/${TASK}/inspect`,
      })
      // RED: returns 404 (route not registered); should be 503
      expect(response.status).toBe(503)
      const body = await fixture.json<{ error: { code: string } }>(response)
      expect(body.error.code).toBe('WRKF_UNAVAILABLE')
    })
  })

  test('[RED] maps WRKF_NOT_FOUND → HTTP 404', async () => {
    const wrkf = makeFakePbcPort({
      next: async () => {
        throw new WrkfError('WRKF_NOT_FOUND', 'task not found')
      },
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'GET',
          path: `/v1/wrkf/pbc/tasks/${TASK}/inspect`,
        })
        // RED: returns 404 for wrong reason (no route); should be 404 from error mapping
        expect(response.status).toBe(404)
        const body = await fixture.json<{ error: { code: string } }>(response)
        expect(body.error.code).toBe('WRKF_NOT_FOUND')
      },
      { wrkf }
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §2 — POST /v1/wrkf/pbc/tasks/:task/run-step
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /v1/wrkf/pbc/tasks/:task/run-step — one participant action (RED)', () => {
  // RED: route not registered → 404; handler not implemented.

  test('[RED] returns 200 with PbcHarnessResult on successful run-step', async () => {
    const wrkf = makeFakePbcPort()

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/wrkf/pbc/tasks/${TASK}/run-step`,
          body: {
            actor: ACTOR,
            idempotencyKey: IDEMPOTENCY_KEY,
            participantOutput: {
              evidence: [{ kind: 'result', summary: 'implementation done' }],
            },
          },
        })

        // RED: 404 (route absent); should be 200 with result
        expect(response.status).toBe(200)
        const body = await fixture.json<Record<string, unknown>>(response)
        expect(body['task']).toBe(TASK)
        expect(body['workflowRef']).toBe('pbc-progressive-refinement@9')
        expect(body['instance']).toBeDefined()
        expect(body['next']).toBeDefined()
      },
      { wrkf }
    )
  })

  test('[RED] run-step passes :task param as `task` to harness (never taskId)', async () => {
    const SPECIFIC_TASK = 'T-55555'
    const wrkf = makeFakePbcPort()

    await withWiredServer(
      async (fixture) => {
        await fixture.request({
          method: 'POST',
          path: `/v1/wrkf/pbc/tasks/${SPECIFIC_TASK}/run-step`,
          body: { actor: ACTOR, idempotencyKey: IDEMPOTENCY_KEY },
        })

        // The harness run.start must receive task, not taskId
        const startCall = wrkf._calls.find((c) => c.method === 'run.start')
        expect(startCall).toBeDefined()
        const p = startCall!.params as Record<string, unknown>
        expect(p['task']).toBe(SPECIFIC_TASK)
        expect(p['taskId']).toBeUndefined()
      },
      { wrkf }
    )
  })

  test('[RED] run-step returns 400 when idempotencyKey is absent from body', async () => {
    const wrkf = makeFakePbcPort()

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/wrkf/pbc/tasks/${TASK}/run-step`,
          body: { actor: ACTOR }, // missing idempotencyKey
        })

        // RED: 404 (route absent); should be 400 (validation)
        expect(response.status).toBe(400)
      },
      { wrkf }
    )
  })

  test('[RED] returns 503 WRKF_UNAVAILABLE when deps.wrkf is absent', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request({
        method: 'POST',
        path: `/v1/wrkf/pbc/tasks/${TASK}/run-step`,
        body: { actor: ACTOR, idempotencyKey: IDEMPOTENCY_KEY },
      })
      expect(response.status).toBe(503)
      const body = await fixture.json<{ error: { code: string } }>(response)
      expect(body.error.code).toBe('WRKF_UNAVAILABLE')
    })
  })

  test('[RED] maps WRKF_TRANSITION_BLOCKED → HTTP 422', async () => {
    const wrkf = makeFakePbcPort({
      transitionApply: async () => {
        throw new WrkfError('WRKF_TRANSITION_BLOCKED', 'evidence requirements not met')
      },
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/wrkf/pbc/tasks/${TASK}/run-step`,
          body: {
            actor: ACTOR,
            idempotencyKey: IDEMPOTENCY_KEY,
            transitionPolicy: 'single-safe',
          },
        })

        // RED: 404 (route); should be 422
        expect(response.status).toBe(422)
        const body = await fixture.json<{ error: { code: string } }>(response)
        expect(body.error.code).toBe('WRKF_TRANSITION_BLOCKED')
      },
      { wrkf }
    )
  })

  test('[RED] maps WRKF_ROLE_DENIED → HTTP 403', async () => {
    const wrkf = makeFakePbcPort({
      runStart: async () => {
        throw new WrkfError('WRKF_ROLE_DENIED', 'role not permitted for this task')
      },
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/wrkf/pbc/tasks/${TASK}/run-step`,
          body: { actor: ACTOR, idempotencyKey: IDEMPOTENCY_KEY },
        })

        // RED: 404 (route); should be 403
        expect(response.status).toBe(403)
        const body = await fixture.json<{ error: { code: string } }>(response)
        expect(body.error.code).toBe('WRKF_ROLE_DENIED')
      },
      { wrkf }
    )
  })

  test('[RED] maps WRKF_STALE_REVISION → HTTP 409', async () => {
    const wrkf = makeFakePbcPort({
      transitionApply: async () => {
        throw new WrkfError('WRKF_STALE_REVISION', 'revision out of date')
      },
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/wrkf/pbc/tasks/${TASK}/run-step`,
          body: {
            actor: ACTOR,
            idempotencyKey: IDEMPOTENCY_KEY,
            transitionPolicy: 'single-safe',
          },
        })

        // RED: 404 (route); should be 409
        expect(response.status).toBe(409)
      },
      { wrkf }
    )
  })

  test('[RED] maps WRKF_CONTEXT_MISMATCH → HTTP 409', async () => {
    const wrkf = makeFakePbcPort({
      transitionApply: async () => {
        throw new WrkfError('WRKF_CONTEXT_MISMATCH', 'context hash mismatch')
      },
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/wrkf/pbc/tasks/${TASK}/run-step`,
          body: {
            actor: ACTOR,
            idempotencyKey: IDEMPOTENCY_KEY,
            transitionPolicy: 'single-safe',
          },
        })

        expect(response.status).toBe(409)
      },
      { wrkf }
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §3 — Idempotency contract (HARD requirement per SPEC §4.15 + daedalus change 4)
// ─────────────────────────────────────────────────────────────────────────────

describe('run-step idempotency — body-hash persistence (RED)', () => {
  // These tests assert the ACP-layer idempotency contract (not wrkf-layer):
  // same route idempotencyKey + same request body → replay (no duplicate evidence).
  // same route idempotencyKey + different body → HTTP 409.

  test('[RED] repeated run-step with SAME idempotencyKey + SAME body does NOT call evidence.add twice', async () => {
    // evidence.add MUST NOT be re-called on replay; wrkf does NOT dedupe evidence.
    const wrkf = makeFakePbcPort()

    const body = {
      actor: ACTOR,
      idempotencyKey: 'idem-replay-test-001',
      participantOutput: {
        evidence: [{ kind: 'result', summary: 'implementation complete' }],
      },
    }

    await withWiredServer(
      async (fixture) => {
        // First request: fresh → evidence.add called, result persisted
        const first = await fixture.request({
          method: 'POST',
          path: `/v1/wrkf/pbc/tasks/${TASK}/run-step`,
          body,
        })
        expect(first.status).toBe(200)

        const evidenceCallsAfterFirst = wrkf._calls.filter(
          (c) => c.method === 'evidence.add'
        ).length

        // Second request: same key + same body → REPLAY (no new evidence.add)
        const second = await fixture.request({
          method: 'POST',
          path: `/v1/wrkf/pbc/tasks/${TASK}/run-step`,
          body,
        })
        // RED: 404 (route absent) on first; should be 200 replay on second
        expect(second.status).toBe(200)

        const evidenceCallsAfterSecond = wrkf._calls.filter(
          (c) => c.method === 'evidence.add'
        ).length

        // Replay must NOT call evidence.add again
        expect(evidenceCallsAfterSecond).toBe(evidenceCallsAfterFirst)
      },
      { wrkf }
    )
  })

  test('[RED] replay returns the same result body as the first request', async () => {
    const wrkf = makeFakePbcPort()

    const requestBody = {
      actor: ACTOR,
      idempotencyKey: 'idem-replay-shape-001',
      participantOutput: { evidence: [] },
    }

    await withWiredServer(
      async (fixture) => {
        const first = await fixture.request({
          method: 'POST',
          path: `/v1/wrkf/pbc/tasks/${TASK}/run-step`,
          body: requestBody,
        })
        expect(first.status).toBe(200)
        const firstBody = await fixture.json<Record<string, unknown>>(first)

        const second = await fixture.request({
          method: 'POST',
          path: `/v1/wrkf/pbc/tasks/${TASK}/run-step`,
          body: requestBody,
        })
        expect(second.status).toBe(200)
        const secondBody = await fixture.json<Record<string, unknown>>(second)

        // Replay must return same result structure
        expect(secondBody['task']).toBe(firstBody['task'])
        expect(secondBody['workflowRef']).toBe(firstBody['workflowRef'])
      },
      { wrkf }
    )
  })

  test('[RED] SAME idempotencyKey + DIFFERENT body → HTTP 409 IDEMPOTENCY_MISMATCH', async () => {
    // This is the body-hash conflict path. The idempotencyKey was already used
    // with a different request body → return 409, do NOT execute.
    const wrkf = makeFakePbcPort()

    const firstBody = {
      actor: ACTOR,
      idempotencyKey: 'idem-conflict-test-001',
      participantOutput: { evidence: [{ kind: 'result', summary: 'first output' }] },
    }
    const conflictBody = {
      actor: ACTOR,
      idempotencyKey: 'idem-conflict-test-001', // SAME key
      participantOutput: { evidence: [{ kind: 'result', summary: 'DIFFERENT output' }] }, // different body
    }

    await withWiredServer(
      async (fixture) => {
        // First request: fresh
        const first = await fixture.request({
          method: 'POST',
          path: `/v1/wrkf/pbc/tasks/${TASK}/run-step`,
          body: firstBody,
        })
        expect(first.status).toBe(200)

        // Second request: same key + different body → conflict
        const conflict = await fixture.request({
          method: 'POST',
          path: `/v1/wrkf/pbc/tasks/${TASK}/run-step`,
          body: conflictBody,
        })
        // RED: 404 (route); should be 409
        expect(conflict.status).toBe(409)
        const conflictResponse = await fixture.json<{ error: { code: string } }>(conflict)
        expect(conflictResponse.error.code).toBe('IDEMPOTENCY_MISMATCH')
      },
      { wrkf }
    )
  })

  test('[RED] idempotency store is checked BEFORE harness execution (not after)', async () => {
    // The store must be consulted before any wrkf call to prevent duplicate evidence.
    // We verify this by asserting that on a replay, NO wrkf methods are called.
    const wrkf = makeFakePbcPort()

    const body = {
      actor: ACTOR,
      idempotencyKey: 'idem-order-test-001',
      participantOutput: { evidence: [] },
    }

    await withWiredServer(
      async (fixture) => {
        // First request: executes normally
        const first = await fixture.request({
          method: 'POST',
          path: `/v1/wrkf/pbc/tasks/${TASK}/run-step`,
          body,
        })
        expect(first.status).toBe(200)

        const callsAfterFirst = wrkf._calls.length

        // Second request: replay; store consulted FIRST → zero new wrkf calls
        const second = await fixture.request({
          method: 'POST',
          path: `/v1/wrkf/pbc/tasks/${TASK}/run-step`,
          body,
        })
        expect(second.status).toBe(200)

        // On replay, no additional wrkf calls should have been made
        expect(wrkf._calls.length).toBe(callsAfterFirst)
      },
      { wrkf }
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §4 — POST /v1/wrkf/pbc/tasks/:task/approve-transition
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /v1/wrkf/pbc/tasks/:task/approve-transition (RED)', () => {
  test('[RED] returns 200 with PbcHarnessResult on successful approve-transition', async () => {
    const wrkf = makeFakePbcPort()

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/wrkf/pbc/tasks/${TASK}/approve-transition`,
          body: {
            transition: 'complete_implementation',
            actor: ACTOR,
            idempotencyKey: IDEMPOTENCY_KEY,
          },
        })

        // RED: 404 (route); should be 200
        expect(response.status).toBe(200)
        const body = await fixture.json<Record<string, unknown>>(response)
        expect(body['task']).toBe(TASK)
        expect(body['workflowRef']).toBe('pbc-progressive-refinement@9')
        expect(body['transitionApplied']).toBeDefined()
      },
      { wrkf }
    )
  })

  test('[RED] approve-transition passes :task param as `task` to harness (never taskId)', async () => {
    const SPECIFIC_TASK = 'T-77777'
    const wrkf = makeFakePbcPort()

    await withWiredServer(
      async (fixture) => {
        await fixture.request({
          method: 'POST',
          path: `/v1/wrkf/pbc/tasks/${SPECIFIC_TASK}/approve-transition`,
          body: {
            transition: 'complete_implementation',
            actor: ACTOR,
            idempotencyKey: IDEMPOTENCY_KEY,
          },
        })

        const applyCall = wrkf._calls.find((c) => c.method === 'transition.apply')
        expect(applyCall).toBeDefined()
        const p = applyCall!.params as Record<string, unknown>
        expect(p['task']).toBe(SPECIFIC_TASK)
        expect(p['taskId']).toBeUndefined()
      },
      { wrkf }
    )
  })

  test('[RED] maps WRKF_TRANSITION_BLOCKED → HTTP 422', async () => {
    const wrkf = makeFakePbcPort({
      transitionApply: async () => {
        throw new WrkfError('WRKF_TRANSITION_BLOCKED', 'blockers: missing evidence')
      },
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/wrkf/pbc/tasks/${TASK}/approve-transition`,
          body: {
            transition: 'complete_implementation',
            actor: ACTOR,
            idempotencyKey: IDEMPOTENCY_KEY,
          },
        })

        expect(response.status).toBe(422)
        const body = await fixture.json<{ error: { code: string } }>(response)
        expect(body.error.code).toBe('WRKF_TRANSITION_BLOCKED')
      },
      { wrkf }
    )
  })

  test('[RED] maps WRKF_ROLE_DENIED → HTTP 403', async () => {
    const wrkf = makeFakePbcPort({
      transitionApply: async () => {
        throw new WrkfError('WRKF_ROLE_DENIED', 'role not allowed to apply this transition')
      },
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/wrkf/pbc/tasks/${TASK}/approve-transition`,
          body: {
            transition: 'complete_implementation',
            actor: ACTOR,
            idempotencyKey: IDEMPOTENCY_KEY,
          },
        })

        expect(response.status).toBe(403)
        const body = await fixture.json<{ error: { code: string } }>(response)
        expect(body.error.code).toBe('WRKF_ROLE_DENIED')
      },
      { wrkf }
    )
  })

  test('[RED] maps WRKF_IDEMPOTENCY_MISMATCH from wrkf → HTTP 409', async () => {
    // This is the WRKF-layer idempotency mismatch (distinct from ACP body-hash mismatch).
    const wrkf = makeFakePbcPort({
      transitionApply: async () => {
        throw new WrkfError('WRKF_IDEMPOTENCY_MISMATCH', 'wrkf idempotency conflict')
      },
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/wrkf/pbc/tasks/${TASK}/approve-transition`,
          body: {
            transition: 'complete_implementation',
            actor: ACTOR,
            idempotencyKey: IDEMPOTENCY_KEY,
          },
        })

        expect(response.status).toBe(409)
        const body = await fixture.json<{ error: { code: string } }>(response)
        expect(body.error.code).toBe('WRKF_IDEMPOTENCY_MISMATCH')
      },
      { wrkf }
    )
  })

  test('[RED] returns 503 WRKF_UNAVAILABLE when deps.wrkf is absent', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request({
        method: 'POST',
        path: `/v1/wrkf/pbc/tasks/${TASK}/approve-transition`,
        body: {
          transition: 'complete_implementation',
          actor: ACTOR,
          idempotencyKey: IDEMPOTENCY_KEY,
        },
      })
      expect(response.status).toBe(503)
      const body = await fixture.json<{ error: { code: string } }>(response)
      expect(body.error.code).toBe('WRKF_UNAVAILABLE')
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §5 — POST /v1/wrkf/pbc/tasks/:task/run-until-blocked
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /v1/wrkf/pbc/tasks/:task/run-until-blocked (RED)', () => {
  test('[RED] returns 200 with PbcHarnessResult.stopReason on completion', async () => {
    // Make next return closed so the autopilot stops immediately.
    const wrkf = makeFakePbcPort({
      next: async () => ({
        instance: {
          state: { status: 'closed', phase: 'done' },
          revision: 9,
          contextHash: 'ctx-closed',
        },
        actions: [],
        blockedTransitions: [],
        openObligations: [],
        pendingEffects: [],
      }),
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/wrkf/pbc/tasks/${TASK}/run-until-blocked`,
          body: {
            actor: ACTOR,
            idempotencyKey: IDEMPOTENCY_KEY,
            maxTurns: 1,
          },
        })

        // RED: 404 (route); should be 200 with stopReason
        expect(response.status).toBe(200)
        const body = await fixture.json<{ stopReason: string; task: string }>(response)
        expect(body.stopReason).toBe('closed')
        expect(body.task).toBe(TASK)
      },
      { wrkf }
    )
  })

  test('[RED] run-until-blocked passes :task param as `task` to harness (never taskId)', async () => {
    const SPECIFIC_TASK = 'T-33333'
    const wrkf = makeFakePbcPort({
      next: async () => ({
        instance: {
          state: { status: 'closed', phase: 'done' },
          revision: 1,
          contextHash: 'ctx-done',
        },
        actions: [],
        blockedTransitions: [],
        openObligations: [],
        pendingEffects: [],
      }),
    })

    await withWiredServer(
      async (fixture) => {
        await fixture.request({
          method: 'POST',
          path: `/v1/wrkf/pbc/tasks/${SPECIFIC_TASK}/run-until-blocked`,
          body: {
            actor: ACTOR,
            idempotencyKey: IDEMPOTENCY_KEY,
            maxTurns: 1,
          },
        })

        const nextCall = wrkf._calls.find((c) => c.method === 'next')
        expect(nextCall).toBeDefined()
        const p = nextCall!.params as Record<string, unknown>
        expect(p['task']).toBe(SPECIFIC_TASK)
        expect(p['taskId']).toBeUndefined()
      },
      { wrkf }
    )
  })

  test('[RED] returns 503 WRKF_UNAVAILABLE when deps.wrkf is absent', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request({
        method: 'POST',
        path: `/v1/wrkf/pbc/tasks/${TASK}/run-until-blocked`,
        body: { actor: ACTOR, idempotencyKey: IDEMPOTENCY_KEY },
      })
      expect(response.status).toBe(503)
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §6 — POST /v1/wrkf/effects/deliver
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /v1/wrkf/effects/deliver — list then deliver per effectId (RED)', () => {
  // RED: route not registered → 404; handler not implemented.
  // Key contract: effect.list({task}) → deliver per effectId. task NOT passed to deliver.

  test('[RED] returns 200 with {delivered, skipped} result', async () => {
    const wrkf = makeFakePbcPort()

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: '/v1/wrkf/effects/deliver',
          body: { task: TASK },
        })

        // RED: 404 (route); should be 200
        expect(response.status).toBe(200)
        const body = await fixture.json<{ delivered: string[]; skipped: unknown[] }>(response)
        expect(Array.isArray(body.delivered)).toBe(true)
        expect(Array.isArray(body.skipped)).toBe(true)
      },
      { wrkf }
    )
  })

  test('[RED] calls effect.list with {task} from request body', async () => {
    const wrkf = makeFakePbcPort()

    await withWiredServer(
      async (fixture) => {
        await fixture.request({
          method: 'POST',
          path: '/v1/wrkf/effects/deliver',
          body: { task: TASK },
        })

        const listCall = wrkf._calls.find((c) => c.method === 'effect.list')
        expect(listCall).toBeDefined()
        const p = listCall!.params as Record<string, unknown>
        expect(p['task']).toBe(TASK)
      },
      { wrkf }
    )
  })

  test('[RED] calls effect.deliver for each pending effect by effectId', async () => {
    const wrkf = makeFakePbcPort()

    await withWiredServer(
      async (fixture) => {
        await fixture.request({
          method: 'POST',
          path: '/v1/wrkf/effects/deliver',
          body: { task: TASK },
        })

        const deliverCalls = wrkf._calls.filter((c) => c.method === 'effect.deliver')
        // CANNED_EFFECTS has 2 pending effects; both should be delivered
        expect(deliverCalls.length).toBeGreaterThanOrEqual(2)

        // Each deliver call must have effectId matching the listed effects
        const effectIds = deliverCalls.map((c) => (c.params as Record<string, unknown>)['effectId'])
        expect(effectIds).toContain('eff-aaa')
        expect(effectIds).toContain('eff-bbb')
      },
      { wrkf }
    )
  })

  test('[RED] effect.deliver is called with effectId only — task is NOT passed to deliver', async () => {
    // SPEC §4.6.5: "task? is server-ignored on effect.deliver"
    // The handler MUST NOT pass task to effect.deliver.
    const wrkf = makeFakePbcPort()

    await withWiredServer(
      async (fixture) => {
        await fixture.request({
          method: 'POST',
          path: '/v1/wrkf/effects/deliver',
          body: { task: TASK },
        })

        const deliverCalls = wrkf._calls.filter((c) => c.method === 'effect.deliver')
        expect(deliverCalls.length).toBeGreaterThan(0)

        for (const call of deliverCalls) {
          const p = call.params as Record<string, unknown>
          // effectId must be present
          expect(typeof p['effectId']).toBe('string')
          // task must NOT be forwarded to deliver
          expect(p['task']).toBeUndefined()
          expect(p['taskId']).toBeUndefined()
        }
      },
      { wrkf }
    )
  })

  test('[RED] delivered effectIds match the ids returned by effect.list', async () => {
    // The route must only deliver effects that effect.list reports as pending.
    const specificEffects = [
      { id: 'eff-xyz-1', kind: 'set_task_state', status: 'pending' },
      { id: 'eff-xyz-2', kind: 'set_task_state', status: 'delivered' }, // not pending → skip
    ]
    const wrkf = makeFakePbcPort({
      effectList: async () => specificEffects,
    })

    await withWiredServer(
      async (fixture) => {
        await fixture.request({
          method: 'POST',
          path: '/v1/wrkf/effects/deliver',
          body: { task: TASK },
        })

        const deliverCalls = wrkf._calls.filter((c) => c.method === 'effect.deliver')
        const deliveredIds = deliverCalls.map(
          (c) => (c.params as Record<string, unknown>)['effectId']
        )

        // Only pending effects should be delivered
        expect(deliveredIds).toContain('eff-xyz-1')
        expect(deliveredIds).not.toContain('eff-xyz-2') // already delivered → skip
      },
      { wrkf }
    )
  })

  test('[RED] WRKF_LEASE_CONFLICT on deliver is skipped (not fatal)', async () => {
    // Per SPEC §4.16: WRKF_LEASE_CONFLICT → skip effect and re-list; not fatal
    let deliverCount = 0
    const wrkf = makeFakePbcPort({
      effectDeliver: async () => {
        deliverCount++
        if (deliverCount === 1) {
          throw new WrkfError('WRKF_LEASE_CONFLICT', 'effect leased by another worker')
        }
        return { status: 'delivered' }
      },
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: '/v1/wrkf/effects/deliver',
          body: { task: TASK },
        })

        // LEASE_CONFLICT must not cause 409 on the route; route still returns 200
        expect(response.status).toBe(200)
        const body = await fixture.json<{ delivered: string[]; skipped: unknown[] }>(response)
        // The conflicted effect should appear in skipped, not delivered
        expect(body.skipped.length).toBeGreaterThan(0)
      },
      { wrkf }
    )
  })

  test('[RED] returns 503 WRKF_UNAVAILABLE when deps.wrkf is absent', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request({
        method: 'POST',
        path: '/v1/wrkf/effects/deliver',
        body: { task: TASK },
      })
      expect(response.status).toBe(503)
      const body = await fixture.json<{ error: { code: string } }>(response)
      expect(body.error.code).toBe('WRKF_UNAVAILABLE')
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §7 — Route registration + mutating-routes authz wrapping
// ─────────────────────────────────────────────────────────────────────────────

describe('Route registration and authz wrapping (RED)', () => {
  // RED: routes not in param-routes.ts / exact-routes.ts → 404 for all 5.

  test('[RED] GET /v1/wrkf/pbc/tasks/:task/inspect is registered (not 404)', async () => {
    const wrkf = makeFakePbcPort()
    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'GET',
          path: `/v1/wrkf/pbc/tasks/${TASK}/inspect`,
        })
        expect(response.status).not.toBe(404)
      },
      { wrkf }
    )
  })

  test('[RED] POST /v1/wrkf/pbc/tasks/:task/run-step is registered (not 404)', async () => {
    const wrkf = makeFakePbcPort()
    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/wrkf/pbc/tasks/${TASK}/run-step`,
          body: { actor: ACTOR, idempotencyKey: IDEMPOTENCY_KEY },
        })
        expect(response.status).not.toBe(404)
      },
      { wrkf }
    )
  })

  test('[RED] POST /v1/wrkf/pbc/tasks/:task/approve-transition is registered (not 404)', async () => {
    const wrkf = makeFakePbcPort()
    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/wrkf/pbc/tasks/${TASK}/approve-transition`,
          body: { transition: 'test', actor: ACTOR, idempotencyKey: IDEMPOTENCY_KEY },
        })
        expect(response.status).not.toBe(404)
      },
      { wrkf }
    )
  })

  test('[RED] POST /v1/wrkf/pbc/tasks/:task/run-until-blocked is registered (not 404)', async () => {
    const wrkf = makeFakePbcPort()
    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/wrkf/pbc/tasks/${TASK}/run-until-blocked`,
          body: { actor: ACTOR, idempotencyKey: IDEMPOTENCY_KEY },
        })
        expect(response.status).not.toBe(404)
      },
      { wrkf }
    )
  })

  test('[RED] POST /v1/wrkf/effects/deliver is registered (not 404)', async () => {
    const wrkf = makeFakePbcPort()
    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: '/v1/wrkf/effects/deliver',
          body: { task: TASK },
        })
        expect(response.status).not.toBe(404)
      },
      { wrkf }
    )
  })

  test('[RED] mutating POST routes respond 403 when authorize returns deny (authz wrapping asserted)', async () => {
    // withActorAndAuthz wrapping is required on all mutating PBC routes.
    // With authorize → 'deny', the wrapped routes must return 403.
    // Without the wrapper, handlers execute directly and return 200/422/etc (not 403).
    const wrkf = makeFakePbcPort()
    const muatingRoutes = [
      {
        method: 'POST',
        path: `/v1/wrkf/pbc/tasks/${TASK}/run-step`,
        body: { actor: ACTOR, idempotencyKey: IDEMPOTENCY_KEY },
      },
      {
        method: 'POST',
        path: `/v1/wrkf/pbc/tasks/${TASK}/approve-transition`,
        body: { transition: 'test', actor: ACTOR, idempotencyKey: IDEMPOTENCY_KEY },
      },
      {
        method: 'POST',
        path: `/v1/wrkf/pbc/tasks/${TASK}/run-until-blocked`,
        body: { actor: ACTOR, idempotencyKey: IDEMPOTENCY_KEY },
      },
      {
        method: 'POST',
        path: '/v1/wrkf/effects/deliver',
        body: { task: TASK },
      },
    ]

    await withWiredServer(
      async (fixture) => {
        for (const route of muatingRoutes) {
          const response = await fixture.request(route)
          // Routes that go through withActorAndAuthz with deny → 403
          // Routes that don't have the wrapper would return something else (200, 422, 503...)
          // RED: returns 404 (not registered) → will be 403 once registered with authz wrapper
          expect(response.status).toBe(403)
        }
      },
      {
        wrkf,
        authorize: () => 'deny', // override to always deny
      }
    )
  })

  test('[RED] GET /v1/wrkf/pbc/tasks/:task/inspect responds 403 when authorize returns deny', async () => {
    const wrkf = makeFakePbcPort()
    const authzCalls: Array<{ operation: string; resource: unknown }> = []

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'GET',
          path: `/v1/wrkf/pbc/tasks/${TASK}/inspect`,
        })
        expect(response.status).toBe(403)
        expect(wrkf._calls).toHaveLength(0)
      },
      {
        wrkf,
        authorize: (_actor, operation, resource) => {
          authzCalls.push({ operation, resource })
          return 'deny'
        },
      }
    )

    expect(authzCalls).toEqual([
      {
        operation: 'wrkf.pbc.inspect',
        resource: { kind: 'wrkf-task', id: TASK },
      },
    ])
  })

  test('[RED] GET /v1/wrkf/pbc/tasks/:task/inspect passes through when authorize returns allow', async () => {
    const wrkf = makeFakePbcPort()

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'GET',
          path: `/v1/wrkf/pbc/tasks/${TASK}/inspect`,
        })
        expect(response.status).toBe(200)
        const body = await fixture.json<Record<string, unknown>>(response)
        expect(body['task']).toBe(TASK)
      },
      {
        wrkf,
        authorize: () => 'allow',
      }
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §8 — Error mapping (SPEC §4.16)
// ─────────────────────────────────────────────────────────────────────────────

describe('Error mapping per SPEC §4.16 (RED)', () => {
  // These tests verify that wrkfErrorToHttpStatus is used consistently across
  // all mutating PBC route handlers.

  test('[RED] approve-transition: WRKF_NOT_FOUND from transition.apply → 404 with code', async () => {
    const wrkf = makeFakePbcPort({
      transitionApply: async () => {
        throw new WrkfError('WRKF_NOT_FOUND', 'transition not found')
      },
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/wrkf/pbc/tasks/${TASK}/approve-transition`,
          body: {
            transition: 'nonexistent_transition',
            actor: ACTOR,
            idempotencyKey: IDEMPOTENCY_KEY,
          },
        })

        // RED: route returns 404 (route not found), not WRKF_NOT_FOUND
        // When green: returns 404 with body.error.code === 'WRKF_NOT_FOUND'
        expect(response.status).toBe(404)
        const body = await fixture.json<{ error: { code: string } }>(response)
        expect(body.error.code).toBe('WRKF_NOT_FOUND')
      },
      { wrkf }
    )
  })

  test('[RED] inspect: WRKF_STALE_REVISION → 409', async () => {
    // Even inspect can hit stale revision if wrkf is in inconsistent state
    const wrkf = makeFakePbcPort({
      next: async () => {
        throw new WrkfError('WRKF_STALE_REVISION', 'inspect stale revision')
      },
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'GET',
          path: `/v1/wrkf/pbc/tasks/${TASK}/inspect`,
        })

        expect(response.status).toBe(409)
      },
      { wrkf }
    )
  })

  test('[RED] run-step: unknown wrkf error code → 500 (safe default)', async () => {
    const wrkf = makeFakePbcPort({
      runStart: async () => {
        throw new WrkfError('WRKF_SOME_FUTURE_CODE', 'future error')
      },
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/wrkf/pbc/tasks/${TASK}/run-step`,
          body: { actor: ACTOR, idempotencyKey: IDEMPOTENCY_KEY },
        })

        expect(response.status).toBe(500)
      },
      { wrkf }
    )
  })
})
