/**
 * RED TESTS — Phase 3: /v1/pbc/* product facade (T-02864)
 *
 * All tests are RED because:
 *   1. Routes not registered in routing/param-routes.ts / routing/mutating-routes.ts
 *      → server returns 404 for all paths.
 *   2. Handler files under src/pbc/ (routes.ts, projection.ts, start.ts, input.ts,
 *      continue.ts, dispose.ts, jobs.ts) do not exist yet.
 *   3. No PbcTaskProjection builder exists.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IMPL CONTRACT — what larry must build to go green
 *
 * Routes (register in routing/param-routes.ts + routing/mutating-routes.ts):
 *
 *   POST /v1/pbc/tasks/:taskId/start       — src/pbc/start.ts
 *   GET  /v1/pbc/tasks/:taskId             — src/pbc/projection.ts (read-only)
 *   POST /v1/pbc/tasks/:taskId/input       — src/pbc/input.ts
 *   POST /v1/pbc/tasks/:taskId/continue    — src/pbc/continue.ts
 *   POST /v1/pbc/tasks/:taskId/dispose     — src/pbc/dispose.ts
 *   GET  /v1/pbc/jobs/:jobId               — src/pbc/jobs.ts (read-only)
 *   POST /v1/pbc/tasks/:taskId/effects/reconcile  — src/pbc/effects.ts (operator)
 *
 * Hard constraints (from daedalus spec):
 *   - requiredPack: 'pbc', requiredWorkflowRef: 'pbc-progressive-refinement@5'
 *   - NEVER expose raw transition IDs, contextHash, obligation wire shapes as required
 *     mutation inputs. body carries form data only.
 *   - actor comes from auth/middleware (x-acp-actor header), NOT from untrusted body.
 *   - Agent role (kind='agent') CANNOT submit clarification_response/patch_decision.
 *   - Disposition is explicit human action only.
 *   - /continue ONLY admits/replays a durable job — NO inline HRC work (no run.start
 *     inside the HTTP request).
 *   - start: inspect task.attach BEFORE calling wrkf.task.attach (guard double-attach).
 *   - start: durable idempotency by (route, taskId, actorHash, idempotencyKey, bodyHash).
 *     Uses stateStore.wrkfRouteIdempotency (WrkfRouteIdempotencyRepo).
 *   - start: active non-PBC instance → 409; closed PBC instance → 409.
 *   - /continue job dedup by (taskId, revisionAtAdmission, idempotencyKey).
 *     Uses stateStore.pbcContinuationJobs (PbcContinuationJobsRepo).
 *   - contextHash is diagnostics-only in projection — never a required mutation field.
 *
 * PbcTaskProjection shape (spec lines 887-977):
 *   source: 'wrkf'
 *   taskId: string
 *   workflowRef: 'pbc-progressive-refinement@5'
 *   task: { title?, state?, projectId?, containerId?, url? }
 *   instance: { id, status, phase, revision, contextHash? (diagnostics only), stale? }
 *   screen: 'starting'|'working'|'clarification'|'patch_decision'|'finalized'|'disposed'|'blocked'|'error'
 *   currentInput?: { kind, prompt?, schema, defaults? }
 *   artifacts: { intake?, behaviorNote?, ... }
 *   obligations: Array<{ id, kind, status, prompt? }>
 *   actions: Array<{ kind, enabled }>
 *   activeJob?: { id, status, startedAt?, finishedAt?, error? }
 *   effects: Array<{ id, kind, status, retryable? }>
 *   diagnostics: { pack: 'pbc', revision, legalTransitions?, stopReason?, warnings? }
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { describe, expect, test } from 'bun:test'

import { withWiredServer } from '../../test/fixtures/wired-server.js'
import type { AcpWrkfWorkflowPort } from '../wrkf/port.js'

// ─── Constants ────────────────────────────────────────────────────────────────

const TASK = 'T-09100'
const IDEMPOTENCY_KEY = 'pbc-product-test-001'
const HUMAN_ACTOR = JSON.stringify({ kind: 'human', id: 'user:product-owner' })
const AGENT_ACTOR = JSON.stringify({ kind: 'agent', id: 'agent:pbc-writer' })
const PBC_WORKFLOW_REF = 'pbc-progressive-refinement@5'

// ─── Canned wrkf responses ────────────────────────────────────────────────────

const INTAKE_NEXT = {
  instance: {
    id: 'inst-pbc-001',
    state: { status: 'active', phase: 'intake' },
    revision: 0,
    contextHash: 'sha256:ctx-intake-0',
  },
  actions: [
    { id: 'normalize_feedback', transition: 'normalize_feedback', role: 'agent' },
  ],
  blockedTransitions: [],
  openObligations: [],
  pendingEffects: [],
}

const BEHAVIOR_NOTE_NEXT = {
  instance: {
    id: 'inst-pbc-001',
    state: { status: 'active', phase: 'behavior_note' },
    revision: 1,
    contextHash: 'sha256:ctx-bn-1',
  },
  actions: [{ id: 'draft_pbc', transition: 'draft_pbc', role: 'agent' }],
  blockedTransitions: [],
  openObligations: [],
  pendingEffects: [],
}

const CLARIFICATION_NEXT = {
  instance: {
    id: 'inst-pbc-001',
    state: { status: 'waiting', phase: 'clarification' },
    revision: 3,
    contextHash: 'sha256:ctx-clarif-3',
  },
  actions: [],
  blockedTransitions: [],
  openObligations: [{ id: 'obl-clarif-1', kind: 'clarification_response', status: 'open' }],
  pendingEffects: [],
}

const PATCH_DECISION_NEXT = {
  instance: {
    id: 'inst-pbc-001',
    state: { status: 'waiting', phase: 'patch_decision' },
    revision: 5,
    contextHash: 'sha256:ctx-patch-5',
  },
  actions: [],
  blockedTransitions: [],
  openObligations: [{ id: 'obl-patch-1', kind: 'patch_decision', status: 'open' }],
  pendingEffects: [],
}

const FINALIZED_NEXT = {
  instance: {
    id: 'inst-pbc-001',
    state: { status: 'closed', phase: 'finalized' },
    revision: 7,
    contextHash: 'sha256:ctx-final-7',
  },
  actions: [],
  blockedTransitions: [],
  openObligations: [],
  pendingEffects: [],
}

// ─── Fake port builder ────────────────────────────────────────────────────────

type PortCall = { method: string; params: unknown }

type FakeProductPortOverrides = {
  taskInspect?: () => Promise<unknown>
  taskAttach?: () => Promise<unknown>
  next?: () => Promise<unknown>
  evidenceAdd?: () => Promise<unknown>
  transitionApply?: () => Promise<unknown>
  effectList?: () => Promise<unknown>
  effectDeliver?: () => Promise<unknown>
  obligationList?: () => Promise<unknown>
  obligationSatisfy?: () => Promise<unknown>
}

type InstrumentedProductPort = AcpWrkfWorkflowPort & { _calls: PortCall[] }

/** Build a fake product wrkf port that records all calls. */
function makeProductFakePort(overrides: FakeProductPortOverrides = {}): InstrumentedProductPort {
  const _calls: PortCall[] = []
  const boom = (name: string) => (): never => {
    throw new Error(`fake product port: ${name} must not be called in this scenario`)
  }

  const port: InstrumentedProductPort = {
    _calls,

    captures: {
      async get(key: string) {
        _calls.push({ method: 'captures.get', params: { key } })
        return undefined
      },
      async set(key: string, record: unknown) {
        _calls.push({ method: 'captures.set', params: { key, record } })
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
      attach: async (params) => {
        _calls.push({ method: 'task.attach', params })
        if (overrides.taskAttach !== undefined) return overrides.taskAttach()
        return { task: (params as Record<string, unknown>)['task'], workflowRef: PBC_WORKFLOW_REF }
      },
      inspect: async (params) => {
        _calls.push({ method: 'task.inspect', params })
        if (overrides.taskInspect !== undefined) return overrides.taskInspect()
        // Default: no instance yet (not attached)
        return { task: { taskId: (params as Record<string, unknown>)['task'], title: 'Test PBC Task' } }
      },
      timeline: boom('task.timeline'),
      refresh: boom('task.refresh'),
      syncMeta: boom('task.syncMeta'),
    },

    next: async (params) => {
      _calls.push({ method: 'next', params })
      if (overrides.next !== undefined) return overrides.next()
      return BEHAVIOR_NOTE_NEXT
    },

    evidence: {
      add: async (params) => {
        _calls.push({ method: 'evidence.add', params })
        if (overrides.evidenceAdd !== undefined) return overrides.evidenceAdd()
        return { id: `ev-${_calls.length}`, kind: (params as Record<string, unknown>)['kind'], task: TASK }
      },
      list: async (params) => {
        _calls.push({ method: 'evidence.list', params })
        return []
      },
      show: boom('evidence.show'),
      suggest: boom('evidence.suggest'),
    },

    obligation: {
      list: async (params) => {
        _calls.push({ method: 'obligation.list', params })
        if (overrides.obligationList !== undefined) return overrides.obligationList()
        return []
      },
      show: boom('obligation.show'),
      satisfy: async (params) => {
        _calls.push({ method: 'obligation.satisfy', params })
        if (overrides.obligationSatisfy !== undefined) return overrides.obligationSatisfy()
        return { id: (params as Record<string, unknown>)['id'], status: 'satisfied' }
      },
      waive: boom('obligation.waive'),
      cancel: boom('obligation.cancel'),
    },

    transition: {
      apply: async (params) => {
        _calls.push({ method: 'transition.apply', params })
        if (overrides.transitionApply !== undefined) return overrides.transitionApply()
        return {
          task: (params as Record<string, unknown>)['task'],
          transition: (params as Record<string, unknown>)['transition'],
          revision: ((params as Record<string, unknown>)['expectRevision'] as number ?? 0) + 1,
        }
      },
    },

    run: {
      start: async (params) => {
        _calls.push({ method: 'run.start', params })
        return { id: `wrkfrun-${_calls.length}`, state: 'active' }
      },
      bindExternal: boom('run.bindExternal'),
      finish: async (params) => {
        _calls.push({ method: 'run.finish', params })
        return { id: (params as Record<string, unknown>)['runId'], state: 'completed' }
      },
      fail: async (params) => {
        _calls.push({ method: 'run.fail', params })
        return { id: (params as Record<string, unknown>)['runId'], state: 'failed' }
      },
      show: boom('run.show'),
      list: boom('run.list'),
    },

    effect: {
      list: async (params) => {
        _calls.push({ method: 'effect.list', params })
        if (overrides.effectList !== undefined) return overrides.effectList()
        return []
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
  } as InstrumentedProductPort

  return port
}

// ─────────────────────────────────────────────────────────────────────────────
// §1 — POST /v1/pbc/tasks/:taskId/start — basic contract
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /v1/pbc/tasks/:taskId/start — basic contract (RED)', () => {
  test('[RED] returns 200 with PbcTaskProjection + job on fresh start', async () => {
    const wrkf = makeProductFakePort({
      next: async () => BEHAVIOR_NOTE_NEXT,
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/start`,
          body: {
            idempotencyKey: IDEMPOTENCY_KEY,
            intake: { title: 'Fix the login button' },
          },
        })

        // RED: returns 404 (route not registered); should be 200
        expect(response.status).toBe(200)
        const body = await fixture.json<Record<string, unknown>>(response)

        // PbcTaskProjection fields
        expect(body['source']).toBe('wrkf')
        expect(body['taskId']).toBe(TASK)
        expect(body['workflowRef']).toBe(PBC_WORKFLOW_REF)
        expect(body['instance']).toBeDefined()
        expect(body['screen']).toBeDefined()
        expect(body['diagnostics']).toBeDefined()
        const diagnostics = body['diagnostics'] as Record<string, unknown>
        expect(diagnostics['pack']).toBe('pbc')

        // Job is returned
        expect(body['activeJob']).toBeDefined()
        const job = body['activeJob'] as Record<string, unknown>
        expect(job['id']).toBeDefined()
        expect(typeof job['status']).toBe('string')
      },
      { wrkf }
    )
  })

  test('[RED] returns 503 WRKF_UNAVAILABLE when deps.wrkf is absent', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request({
        method: 'POST',
        path: `/v1/pbc/tasks/${TASK}/start`,
        body: { idempotencyKey: IDEMPOTENCY_KEY, intake: { title: 'test' } },
      })
      // RED: returns 404; should be 503
      expect(response.status).toBe(503)
      const body = await fixture.json<{ error: { code: string } }>(response)
      expect(body.error.code).toBe('WRKF_UNAVAILABLE')
    })
  })

  test('[RED] returns 400 when idempotencyKey is absent', async () => {
    const wrkf = makeProductFakePort()
    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/start`,
          body: { intake: { title: 'test' } }, // missing idempotencyKey
        })
        // RED: returns 404; should be 400
        expect(response.status).toBe(400)
      },
      { wrkf }
    )
  })

  test('[RED] start creates a PBC continuation job record in stateStore', async () => {
    const wrkf = makeProductFakePort({
      next: async () => BEHAVIOR_NOTE_NEXT,
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/start`,
          body: { idempotencyKey: 'start-job-create-test', intake: { title: 'test' } },
        })
        // RED: returns 404; should be 200
        expect(response.status).toBe(200)

        // A job record must be persisted in stateStore
        const allJobs = fixture.stateStore.pbcContinuationJobs.listByStatus('queued')
        const taskJobs = allJobs.filter((j) => j.taskId === TASK)
        expect(taskJobs.length).toBeGreaterThan(0)
      },
      { wrkf }
    )
  })

  test('[RED] start does NOT create job when instance is waiting for human input', async () => {
    // If the instance is already waiting (human gate), no new job should be admitted
    const wrkf = makeProductFakePort({
      taskInspect: async () => ({
        task: { taskId: TASK },
        instance: {
          id: 'inst-pbc-002',
          workflowRef: PBC_WORKFLOW_REF,
          state: { status: 'waiting', phase: 'clarification' },
          revision: 3,
        },
      }),
      next: async () => CLARIFICATION_NEXT,
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/start`,
          body: { idempotencyKey: 'start-no-job-waiting', intake: { title: 'test' } },
        })
        // RED: returns 404; should be 200
        expect(response.status).toBe(200)

        // No job admitted: waiting status = human gate
        const allQueued = fixture.stateStore.pbcContinuationJobs.listByStatus('queued')
        const taskJobs = allQueued.filter((j) => j.taskId === TASK)
        expect(taskJobs).toHaveLength(0)
      },
      { wrkf }
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §2 — POST /v1/pbc/tasks/:taskId/start — idempotency contract
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /v1/pbc/tasks/:taskId/start — durable idempotency (RED)', () => {
  test('[RED] same idempotencyKey + same body → replay (no duplicate wrkf calls)', async () => {
    const wrkf = makeProductFakePort({ next: async () => BEHAVIOR_NOTE_NEXT })

    const body = {
      idempotencyKey: 'start-idem-replay-001',
      intake: { title: 'Fix login button (idempotency test)' },
    }

    await withWiredServer(
      async (fixture) => {
        // First call: fresh
        const first = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/start`,
          body,
        })
        expect(first.status).toBe(200)

        const callsAfterFirst = wrkf._calls.length

        // Second call: same key + same body → replay
        const second = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/start`,
          body,
        })
        // RED: returns 404; should be 200 replay
        expect(second.status).toBe(200)

        // On replay, no new wrkf calls (evidence.add, task.attach, etc.)
        expect(wrkf._calls.length).toBe(callsAfterFirst)
      },
      { wrkf }
    )
  })

  test('[RED] same idempotencyKey + same body → replay returns same response shape', async () => {
    const wrkf = makeProductFakePort({ next: async () => BEHAVIOR_NOTE_NEXT })

    const body = {
      idempotencyKey: 'start-idem-shape-001',
      intake: { title: 'Fix login button (shape test)' },
    }

    await withWiredServer(
      async (fixture) => {
        const first = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/start`,
          body,
        })
        expect(first.status).toBe(200)
        const firstBody = await fixture.json<Record<string, unknown>>(first)

        const second = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/start`,
          body,
        })
        expect(second.status).toBe(200)
        const secondBody = await fixture.json<Record<string, unknown>>(second)

        // Both responses have same shape
        expect(secondBody['taskId']).toBe(firstBody['taskId'])
        expect(secondBody['source']).toBe(firstBody['source'])
        expect(secondBody['workflowRef']).toBe(firstBody['workflowRef'])
      },
      { wrkf }
    )
  })

  test('[RED] same idempotencyKey + DIFFERENT body → 409 IDEMPOTENCY_MISMATCH', async () => {
    const wrkf = makeProductFakePort({ next: async () => BEHAVIOR_NOTE_NEXT })

    await withWiredServer(
      async (fixture) => {
        // First call with one body
        const first = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/start`,
          body: {
            idempotencyKey: 'start-idem-conflict-001',
            intake: { title: 'Fix login button — original' },
          },
        })
        expect(first.status).toBe(200)

        // Second call — SAME key, DIFFERENT body
        const conflict = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/start`,
          body: {
            idempotencyKey: 'start-idem-conflict-001', // same key
            intake: { title: 'Fix login button — DIFFERENT' }, // different body
          },
        })
        // RED: returns 404; should be 409
        expect(conflict.status).toBe(409)
        const conflictBody = await fixture.json<{ error: { code: string } }>(conflict)
        expect(conflictBody.error.code).toBe('IDEMPOTENCY_MISMATCH')
      },
      { wrkf }
    )
  })

  test('[RED] evidence.add not re-called on replay (intake_metadata idempotency)', async () => {
    const wrkf = makeProductFakePort({ next: async () => BEHAVIOR_NOTE_NEXT })
    const body = {
      idempotencyKey: 'start-no-dup-evidence-001',
      intake: { title: 'No duplicate evidence test' },
    }

    await withWiredServer(
      async (fixture) => {
        const first = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/start`,
          body,
        })
        expect(first.status).toBe(200)

        const evidenceAddCountAfterFirst = wrkf._calls.filter((c) => c.method === 'evidence.add').length

        // Replay: no new evidence.add
        const second = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/start`,
          body,
        })
        expect(second.status).toBe(200)

        const evidenceAddCountAfterSecond = wrkf._calls.filter((c) => c.method === 'evidence.add').length
        expect(evidenceAddCountAfterSecond).toBe(evidenceAddCountAfterFirst)
      },
      { wrkf }
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §3 — POST /v1/pbc/tasks/:taskId/start — duplicate-attach guard
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /v1/pbc/tasks/:taskId/start — duplicate-attach guard (RED)', () => {
  test('[RED] task.inspect is called BEFORE task.attach (inspect-first guard)', async () => {
    const wrkf = makeProductFakePort({ next: async () => BEHAVIOR_NOTE_NEXT })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/start`,
          body: { idempotencyKey: 'attach-guard-001', intake: { title: 'test' } },
        })
        // RED: returns 404; should be 200
        expect(response.status).toBe(200)

        const methods = wrkf._calls.map((c) => c.method)
        const inspectIdx = methods.indexOf('task.inspect')
        const attachIdx = methods.indexOf('task.attach')

        // inspect must occur (even if attach is never called)
        expect(inspectIdx).toBeGreaterThan(-1)

        // If attach is called, it must come AFTER inspect
        if (attachIdx >= 0) {
          expect(attachIdx).toBeGreaterThan(inspectIdx)
        }
      },
      { wrkf }
    )
  })

  test('[RED] task.attach NOT called when PBC instance already exists and is active', async () => {
    const wrkf = makeProductFakePort({
      taskInspect: async () => ({
        task: { taskId: TASK },
        instance: {
          id: 'inst-pbc-existing',
          workflowRef: PBC_WORKFLOW_REF,
          state: { status: 'active', phase: 'behavior_note' },
          revision: 2,
          contextHash: 'sha256:ctx-bn-2',
        },
      }),
      next: async () => BEHAVIOR_NOTE_NEXT,
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/start`,
          body: { idempotencyKey: 'no-reattach-001', intake: { title: 'test' } },
        })
        // RED: returns 404; should be 200 (reuse existing)
        expect(response.status).toBe(200)

        // task.attach must NOT be called — instance already exists
        const attachCalls = wrkf._calls.filter((c) => c.method === 'task.attach')
        expect(attachCalls).toHaveLength(0)
      },
      { wrkf }
    )
  })

  test('[RED] task.attach IS called when no instance exists', async () => {
    const wrkf = makeProductFakePort({
      // Default taskInspect returns no instance
      next: async () => BEHAVIOR_NOTE_NEXT,
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/start`,
          body: { idempotencyKey: 'fresh-attach-001', intake: { title: 'test' } },
        })
        // RED: returns 404; should be 200
        expect(response.status).toBe(200)

        // task.attach MUST be called when no instance
        const attachCalls = wrkf._calls.filter((c) => c.method === 'task.attach')
        expect(attachCalls.length).toBeGreaterThan(0)

        // Attach must use PBC workflow ref
        const attachParams = attachCalls[0]!.params as Record<string, unknown>
        expect(typeof attachParams['workflow']).toBe('string')
        expect(String(attachParams['workflow'])).toContain('pbc')
      },
      { wrkf }
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §4 — POST /v1/pbc/tasks/:taskId/start — conflict scenarios
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /v1/pbc/tasks/:taskId/start — conflict scenarios (RED)', () => {
  test('[RED] active non-PBC instance → 409 conflict', async () => {
    const wrkf = makeProductFakePort({
      taskInspect: async () => ({
        task: { taskId: TASK },
        instance: {
          id: 'inst-non-pbc',
          workflowRef: 'some-other-workflow@3',
          state: { status: 'active', phase: 'review' },
          revision: 5,
        },
      }),
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/start`,
          body: { idempotencyKey: 'non-pbc-conflict-001', intake: { title: 'test' } },
        })
        // RED: returns 404; should be 409 INSTANCE_CONFLICT
        expect(response.status).toBe(409)
        const body = await fixture.json<{ error: { code: string } }>(response)
        expect(body.error.code).toMatch(/CONFLICT|INSTANCE_CONFLICT/)
      },
      { wrkf }
    )
  })

  test('[RED] closed PBC instance → 409 conflict (no restart semantics)', async () => {
    const wrkf = makeProductFakePort({
      taskInspect: async () => ({
        task: { taskId: TASK },
        instance: {
          id: 'inst-pbc-closed',
          workflowRef: PBC_WORKFLOW_REF,
          state: { status: 'closed', phase: 'finalized' },
          revision: 9,
        },
      }),
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/start`,
          body: { idempotencyKey: 'closed-pbc-conflict-001', intake: { title: 'test' } },
        })
        // RED: returns 404; should be 409 (closed PBC, no restart semantics)
        expect(response.status).toBe(409)
        const body = await fixture.json<{ error: { code: string } }>(response)
        expect(body.error.code).toMatch(/CONFLICT|INSTANCE_CLOSED|CLOSED/)
      },
      { wrkf }
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §5 — GET /v1/pbc/tasks/:taskId — PbcTaskProjection shape
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /v1/pbc/tasks/:taskId — PbcTaskProjection shape (RED)', () => {
  test('[RED] returns 200 with PbcTaskProjection on successful read', async () => {
    const wrkf = makeProductFakePort({ next: async () => BEHAVIOR_NOTE_NEXT })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'GET',
          path: `/v1/pbc/tasks/${TASK}`,
        })
        // RED: returns 404; should be 200
        expect(response.status).toBe(200)
        const body = await fixture.json<Record<string, unknown>>(response)

        // Required top-level fields
        expect(body['source']).toBe('wrkf')
        expect(body['taskId']).toBe(TASK)
        expect(body['workflowRef']).toBe(PBC_WORKFLOW_REF)
        expect(body['instance']).toBeDefined()
        expect(typeof body['screen']).toBe('string')
        expect(Array.isArray(body['actions'])).toBe(true)
        expect(Array.isArray(body['obligations'])).toBe(true)
        expect(Array.isArray(body['effects'])).toBe(true)
        expect(body['artifacts']).toBeDefined()
        expect(body['diagnostics']).toBeDefined()
      },
      { wrkf }
    )
  })

  test('[RED] instance field has id, status, phase, revision', async () => {
    const wrkf = makeProductFakePort({ next: async () => BEHAVIOR_NOTE_NEXT })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'GET',
          path: `/v1/pbc/tasks/${TASK}`,
        })
        expect(response.status).toBe(200)
        const body = await fixture.json<Record<string, unknown>>(response)
        const instance = body['instance'] as Record<string, unknown>

        expect(typeof instance['id']).toBe('string')
        expect(typeof instance['status']).toBe('string')
        expect(typeof instance['phase']).toBe('string')
        expect(typeof instance['revision']).toBe('number')
      },
      { wrkf }
    )
  })

  test('[RED] screen is a valid PBC screen value', async () => {
    const validScreens = [
      'starting', 'working', 'clarification', 'patch_decision',
      'finalized', 'disposed', 'blocked', 'error',
    ]
    const wrkf = makeProductFakePort({ next: async () => BEHAVIOR_NOTE_NEXT })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'GET',
          path: `/v1/pbc/tasks/${TASK}`,
        })
        expect(response.status).toBe(200)
        const body = await fixture.json<Record<string, unknown>>(response)
        expect(validScreens).toContain(body['screen'])
      },
      { wrkf }
    )
  })

  test('[RED] diagnostics.pack is "pbc" and diagnostics.revision is a number', async () => {
    const wrkf = makeProductFakePort({ next: async () => BEHAVIOR_NOTE_NEXT })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'GET',
          path: `/v1/pbc/tasks/${TASK}`,
        })
        expect(response.status).toBe(200)
        const body = await fixture.json<Record<string, unknown>>(response)
        const diagnostics = body['diagnostics'] as Record<string, unknown>

        expect(diagnostics['pack']).toBe('pbc')
        expect(typeof diagnostics['revision']).toBe('number')
      },
      { wrkf }
    )
  })

  test('[RED] returns 503 WRKF_UNAVAILABLE when deps.wrkf is absent', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request({
        method: 'GET',
        path: `/v1/pbc/tasks/${TASK}`,
      })
      expect(response.status).toBe(503)
      const body = await fixture.json<{ error: { code: string } }>(response)
      expect(body.error.code).toBe('WRKF_UNAVAILABLE')
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §6 — contextHash is diagnostics-only (NEVER required mutation input)
// ─────────────────────────────────────────────────────────────────────────────

describe('contextHash is diagnostics-only — NOT a required mutation input (RED)', () => {
  test('[RED] start: body WITHOUT contextHash still returns 200 (not required)', async () => {
    const wrkf = makeProductFakePort({ next: async () => BEHAVIOR_NOTE_NEXT })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/start`,
          body: {
            idempotencyKey: 'no-context-hash-start',
            intake: { title: 'test' },
            // NO contextHash in body
          },
        })
        // RED: returns 404; should be 200 (contextHash not required)
        expect(response.status).toBe(200)
      },
      { wrkf }
    )
  })

  test('[RED] projection contextHash lives under instance or diagnostics, NOT at top-level', async () => {
    const wrkf = makeProductFakePort({ next: async () => BEHAVIOR_NOTE_NEXT })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'GET',
          path: `/v1/pbc/tasks/${TASK}`,
        })
        expect(response.status).toBe(200)
        const body = await fixture.json<Record<string, unknown>>(response)

        // contextHash must NOT appear as a top-level field of the projection
        // (it can only appear nested under instance.contextHash or diagnostics)
        expect(body['contextHash']).toBeUndefined()

        // It is OK for contextHash to appear in instance (diagnostics only)
        // or diagnostics sub-object — that is the correct location
      },
      { wrkf }
    )
  })

  test('[RED] /continue: body WITHOUT contextHash still returns 200 (not required)', async () => {
    const wrkf = makeProductFakePort({ next: async () => BEHAVIOR_NOTE_NEXT })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/continue`,
          body: {
            idempotencyKey: 'continue-no-ctx-hash',
            // NO contextHash in body
          },
        })
        // RED: returns 404; should be 200
        expect(response.status).toBe(200)
      },
      { wrkf }
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §7 — POST /v1/pbc/tasks/:taskId/input — human actor + screen checks
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /v1/pbc/tasks/:taskId/input — human actor + screen checks (RED)', () => {
  test('[RED] HUMAN actor with clarification_response on clarification screen → 200', async () => {
    const wrkf = makeProductFakePort({
      next: async () => CLARIFICATION_NEXT,
      obligationList: async () => [
        { id: 'obl-clarif-1', kind: 'clarification_response', status: 'open' },
      ],
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/input`,
          headers: { 'x-acp-actor': HUMAN_ACTOR },
          body: {
            idempotencyKey: 'input-human-clarif-001',
            kind: 'clarification_response',
            data: { answer: 'The user double-clicks the save button' },
          },
        })
        // RED: returns 404; should be 200
        expect(response.status).toBe(200)
      },
      { wrkf }
    )
  })

  test('[RED] AGENT actor on /input → 403 (agent role rejected for clarification_response)', async () => {
    const wrkf = makeProductFakePort({
      next: async () => CLARIFICATION_NEXT,
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/input`,
          headers: { 'x-acp-actor': AGENT_ACTOR },
          body: {
            idempotencyKey: 'input-agent-rejected-001',
            kind: 'clarification_response',
            data: { answer: 'agent tries to answer' },
          },
        })
        // RED: returns 404; should be 403
        expect(response.status).toBe(403)
      },
      { wrkf }
    )
  })

  test('[RED] AGENT actor on /input → 403 (agent role rejected for patch_decision)', async () => {
    const wrkf = makeProductFakePort({
      next: async () => PATCH_DECISION_NEXT,
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/input`,
          headers: { 'x-acp-actor': AGENT_ACTOR },
          body: {
            idempotencyKey: 'input-agent-patch-001',
            kind: 'patch_decision',
            data: { route: 'finalize' },
          },
        })
        // RED: returns 404; should be 403
        expect(response.status).toBe(403)
      },
      { wrkf }
    )
  })

  test('[RED] wrong screen kind → 422 (clarification_response submitted on patch_decision screen)', async () => {
    const wrkf = makeProductFakePort({
      next: async () => PATCH_DECISION_NEXT, // screen is patch_decision
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/input`,
          headers: { 'x-acp-actor': HUMAN_ACTOR },
          body: {
            idempotencyKey: 'wrong-screen-kind-001',
            kind: 'clarification_response', // wrong: current screen is patch_decision
            data: { answer: 'wrong screen input' },
          },
        })
        // RED: returns 404; should be 422 WRONG_SCREEN_KIND or 400
        expect(response.status).toBeGreaterThanOrEqual(400)
        expect(response.status).toBeLessThan(500)
        const body = await fixture.json<{ error: { code: string } }>(response)
        expect(body.error.code).toMatch(/WRONG_SCREEN|INVALID_KIND|SCREEN/)
      },
      { wrkf }
    )
  })

  test('[RED] wrong screen kind → 422 (patch_decision submitted on clarification screen)', async () => {
    const wrkf = makeProductFakePort({
      next: async () => CLARIFICATION_NEXT, // screen is clarification
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/input`,
          headers: { 'x-acp-actor': HUMAN_ACTOR },
          body: {
            idempotencyKey: 'wrong-screen-kind-002',
            kind: 'patch_decision', // wrong: current screen is clarification
            data: { route: 'finalize' },
          },
        })
        // RED: returns 404; should be 422
        expect(response.status).toBeGreaterThanOrEqual(400)
        expect(response.status).toBeLessThan(500)
      },
      { wrkf }
    )
  })

  test('[RED] /input applies answer_clarification transition on clarification screen', async () => {
    const wrkf = makeProductFakePort({
      next: async () => CLARIFICATION_NEXT,
      obligationList: async () => [
        { id: 'obl-clarif-1', kind: 'clarification_response', status: 'open' },
      ],
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/input`,
          headers: { 'x-acp-actor': HUMAN_ACTOR },
          body: {
            idempotencyKey: 'input-apply-answer-001',
            kind: 'clarification_response',
            data: { answer: 'The user double-clicks the save button' },
          },
        })
        // RED: returns 404; should be 200
        expect(response.status).toBe(200)

        // answer_clarification must be applied
        const applyCalls = wrkf._calls.filter((c) => c.method === 'transition.apply')
        expect(applyCalls.length).toBeGreaterThan(0)
        const transitionNames = applyCalls.map(
          (c) => (c.params as Record<string, unknown>)['transition']
        )
        expect(transitionNames.some((t) => String(t).includes('answer_clarification') || String(t).includes('clarification'))).toBe(true)
      },
      { wrkf }
    )
  })

  test('[RED] /input returns PbcTaskProjection after successful input', async () => {
    const wrkf = makeProductFakePort({
      next: async () => CLARIFICATION_NEXT,
      obligationList: async () => [
        { id: 'obl-clarif-1', kind: 'clarification_response', status: 'open' },
      ],
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/input`,
          headers: { 'x-acp-actor': HUMAN_ACTOR },
          body: {
            idempotencyKey: 'input-proj-return-001',
            kind: 'clarification_response',
            data: { answer: 'test answer' },
          },
        })
        expect(response.status).toBe(200)
        const body = await fixture.json<Record<string, unknown>>(response)

        // Should return PbcTaskProjection
        expect(body['source']).toBe('wrkf')
        expect(body['taskId']).toBe(TASK)
        expect(body['workflowRef']).toBe(PBC_WORKFLOW_REF)
      },
      { wrkf }
    )
  })

  test('[RED] returns 503 WRKF_UNAVAILABLE when deps.wrkf is absent', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request({
        method: 'POST',
        path: `/v1/pbc/tasks/${TASK}/input`,
        headers: { 'x-acp-actor': HUMAN_ACTOR },
        body: {
          idempotencyKey: 'input-no-wrkf',
          kind: 'clarification_response',
          data: { answer: 'test' },
        },
      })
      expect(response.status).toBe(503)
      const body = await fixture.json<{ error: { code: string } }>(response)
      expect(body.error.code).toBe('WRKF_UNAVAILABLE')
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §8 — POST /v1/pbc/tasks/:taskId/continue — durable job only, dedup
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /v1/pbc/tasks/:taskId/continue — durable job, NO inline HRC (RED)', () => {
  test('[RED] returns 200 with PbcTaskProjection + job', async () => {
    const wrkf = makeProductFakePort({ next: async () => BEHAVIOR_NOTE_NEXT })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/continue`,
          body: { idempotencyKey: 'continue-basic-001' },
        })
        // RED: returns 404; should be 200
        expect(response.status).toBe(200)
        const body = await fixture.json<Record<string, unknown>>(response)

        expect(body['source']).toBe('wrkf')
        expect(body['taskId']).toBe(TASK)
        expect(body['activeJob']).toBeDefined()
        const job = body['activeJob'] as Record<string, unknown>
        expect(job['id']).toBeDefined()
        expect(['queued', 'running']).toContain(job['status'])
      },
      { wrkf }
    )
  })

  test('[RED] /continue does NOT call run.start (no inline HRC work in HTTP handler)', async () => {
    const wrkf = makeProductFakePort({ next: async () => BEHAVIOR_NOTE_NEXT })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/continue`,
          body: { idempotencyKey: 'continue-no-hrc-001' },
        })
        // RED: returns 404; should be 200
        expect(response.status).toBe(200)

        // run.start MUST NOT be called in the HTTP handler — that's the worker's job
        const runStartCalls = wrkf._calls.filter((c) => c.method === 'run.start')
        expect(runStartCalls).toHaveLength(0)
      },
      { wrkf }
    )
  })

  test('[RED] /continue creates a job record in stateStore.pbcContinuationJobs', async () => {
    const wrkf = makeProductFakePort({ next: async () => BEHAVIOR_NOTE_NEXT })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/continue`,
          body: { idempotencyKey: 'continue-job-create-001' },
        })
        expect(response.status).toBe(200)

        // A queued (or running) job must exist in the state store
        const queuedJobs = fixture.stateStore.pbcContinuationJobs.listByStatus('queued')
        const runningJobs = fixture.stateStore.pbcContinuationJobs.listByStatus('running')
        const allActiveJobs = [...queuedJobs, ...runningJobs].filter((j) => j.taskId === TASK)
        expect(allActiveJobs.length).toBeGreaterThan(0)
      },
      { wrkf }
    )
  })

  test('[RED] same revision → same job returned (dedup by task+revision)', async () => {
    const wrkf = makeProductFakePort({
      // Keep returning the same revision so dedup fires
      next: async () => ({
        ...BEHAVIOR_NOTE_NEXT,
        instance: { ...BEHAVIOR_NOTE_NEXT.instance, revision: 42 },
      }),
    })

    await withWiredServer(
      async (fixture) => {
        const body = { idempotencyKey: 'continue-dedup-rev-001' }

        const first = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/continue`,
          body,
        })
        expect(first.status).toBe(200)
        const firstBody = await fixture.json<Record<string, unknown>>(first)
        const firstJobId = (firstBody['activeJob'] as Record<string, unknown>)['id']

        const second = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/continue`,
          body,
        })
        // RED: returns 404; should be 200 with same job
        expect(second.status).toBe(200)
        const secondBody = await fixture.json<Record<string, unknown>>(second)
        const secondJobId = (secondBody['activeJob'] as Record<string, unknown>)['id']

        // Same job ID returned (deduped)
        expect(secondJobId).toBe(firstJobId)
      },
      { wrkf }
    )
  })

  test('[RED] waiting instance → 200 but NO new job admitted', async () => {
    // If the task is waiting for human input, /continue should return projection
    // without admitting a new continuation job
    const wrkf = makeProductFakePort({ next: async () => CLARIFICATION_NEXT })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/continue`,
          body: { idempotencyKey: 'continue-waiting-001' },
        })
        // RED: returns 404; should be 200
        expect(response.status).toBe(200)

        // No job queued for a waiting instance
        const queuedJobs = fixture.stateStore.pbcContinuationJobs
          .listByStatus('queued')
          .filter((j) => j.taskId === TASK)
        expect(queuedJobs).toHaveLength(0)
      },
      { wrkf }
    )
  })

  test('[RED] returns 503 WRKF_UNAVAILABLE when deps.wrkf is absent', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request({
        method: 'POST',
        path: `/v1/pbc/tasks/${TASK}/continue`,
        body: { idempotencyKey: 'continue-no-wrkf' },
      })
      expect(response.status).toBe(503)
      const body = await fixture.json<{ error: { code: string } }>(response)
      expect(body.error.code).toBe('WRKF_UNAVAILABLE')
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §9 — POST /v1/pbc/tasks/:taskId/dispose — human actor + validation
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /v1/pbc/tasks/:taskId/dispose — human actor + validation (RED)', () => {
  test('[RED] HUMAN actor with valid resolution → 200 with disposed projection', async () => {
    const wrkf = makeProductFakePort({
      next: async () => BEHAVIOR_NOTE_NEXT,
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/dispose`,
          headers: { 'x-acp-actor': HUMAN_ACTOR },
          body: {
            idempotencyKey: 'dispose-human-001',
            resolution: 'abandoned',
            reason: 'Requirements changed completely',
          },
        })
        // RED: returns 404; should be 200
        expect(response.status).toBe(200)
        const body = await fixture.json<Record<string, unknown>>(response)
        expect(body['source']).toBe('wrkf')
        expect(body['taskId']).toBe(TASK)
      },
      { wrkf }
    )
  })

  test('[RED] AGENT actor on /dispose → 403 (disposition is human-only)', async () => {
    const wrkf = makeProductFakePort({
      next: async () => BEHAVIOR_NOTE_NEXT,
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/dispose`,
          headers: { 'x-acp-actor': AGENT_ACTOR },
          body: {
            idempotencyKey: 'dispose-agent-rejected-001',
            resolution: 'abandoned',
            reason: 'Agent tries to dispose',
          },
        })
        // RED: returns 404; should be 403
        expect(response.status).toBe(403)
      },
      { wrkf }
    )
  })

  test('[RED] missing reason → 400 (reason is required for dispose)', async () => {
    const wrkf = makeProductFakePort({ next: async () => BEHAVIOR_NOTE_NEXT })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/dispose`,
          headers: { 'x-acp-actor': HUMAN_ACTOR },
          body: {
            idempotencyKey: 'dispose-no-reason-001',
            resolution: 'abandoned',
            // missing reason
          },
        })
        // RED: returns 404; should be 400
        expect(response.status).toBe(400)
      },
      { wrkf }
    )
  })

  test('[RED] missing resolution → 400 (resolution is required for dispose)', async () => {
    const wrkf = makeProductFakePort({ next: async () => BEHAVIOR_NOTE_NEXT })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/dispose`,
          headers: { 'x-acp-actor': HUMAN_ACTOR },
          body: {
            idempotencyKey: 'dispose-no-resolution-001',
            reason: 'some reason but no resolution',
            // missing resolution
          },
        })
        // RED: returns 404; should be 400
        expect(response.status).toBe(400)
      },
      { wrkf }
    )
  })

  test('[RED] dispose applies dispose_from_* transition matching current phase', async () => {
    const wrkf = makeProductFakePort({
      next: async () => BEHAVIOR_NOTE_NEXT, // phase = behavior_note
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/dispose`,
          headers: { 'x-acp-actor': HUMAN_ACTOR },
          body: {
            idempotencyKey: 'dispose-transition-001',
            resolution: 'abandoned',
            reason: 'Scope dropped from sprint',
          },
        })
        // RED: returns 404; should be 200
        expect(response.status).toBe(200)

        // dispose_from_behavior_note (or similar) must be applied
        const applyCalls = wrkf._calls.filter((c) => c.method === 'transition.apply')
        expect(applyCalls.length).toBeGreaterThan(0)

        const transitionNames = applyCalls.map(
          (c) => (c.params as Record<string, unknown>)['transition']
        )
        expect(transitionNames.some((t) => String(t).startsWith('dispose_from_'))).toBe(true)
      },
      { wrkf }
    )
  })

  test('[RED] dispose adds disposition_decision evidence before applying transition', async () => {
    const wrkf = makeProductFakePort({
      next: async () => BEHAVIOR_NOTE_NEXT,
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/dispose`,
          headers: { 'x-acp-actor': HUMAN_ACTOR },
          body: {
            idempotencyKey: 'dispose-evidence-order-001',
            resolution: 'abandoned',
            reason: 'Out of scope',
          },
        })
        expect(response.status).toBe(200)

        // disposition_decision evidence must be added
        const evidenceAdds = wrkf._calls.filter((c) => c.method === 'evidence.add')
        const dispositionEv = evidenceAdds.find(
          (c) => (c.params as Record<string, unknown>)['kind'] === 'disposition_decision'
        )
        expect(dispositionEv).toBeDefined()

        // evidence.add must come BEFORE transition.apply
        const methods = wrkf._calls.map((c) => c.method)
        const evidenceIdx = methods.indexOf('evidence.add')
        const transitionIdx = methods.indexOf('transition.apply')
        expect(evidenceIdx).toBeGreaterThan(-1)
        expect(transitionIdx).toBeGreaterThan(evidenceIdx)
      },
      { wrkf }
    )
  })

  test('[RED] returns 503 WRKF_UNAVAILABLE when deps.wrkf is absent', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request({
        method: 'POST',
        path: `/v1/pbc/tasks/${TASK}/dispose`,
        headers: { 'x-acp-actor': HUMAN_ACTOR },
        body: {
          idempotencyKey: 'dispose-no-wrkf',
          resolution: 'abandoned',
          reason: 'test',
        },
      })
      expect(response.status).toBe(503)
      const body = await fixture.json<{ error: { code: string } }>(response)
      expect(body.error.code).toBe('WRKF_UNAVAILABLE')
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §10 — GET /v1/pbc/jobs/:jobId — job status from pbc_continuation_jobs
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /v1/pbc/jobs/:jobId — job status (RED)', () => {
  test('[RED] returns job record by ID from pbc_continuation_jobs', async () => {
    await withWiredServer(async (fixture) => {
      // Pre-seed a job record
      const { job } = fixture.stateStore.pbcContinuationJobs.admit({
        taskId: TASK,
        workflowRef: PBC_WORKFLOW_REF,
        revisionAtAdmission: '5',
        idempotencyKey: 'job-get-test-001',
      })

      const response = await fixture.request({
        method: 'GET',
        path: `/v1/pbc/jobs/${job.jobId}`,
      })
      // RED: returns 404; should be 200
      expect(response.status).toBe(200)
      const body = await fixture.json<Record<string, unknown>>(response)

      expect(body['id']).toBe(job.jobId)
      expect(body['taskId']).toBe(TASK)
      expect(body['workflowRef']).toBe(PBC_WORKFLOW_REF)
      expect(typeof body['status']).toBe('string')
    })
  })

  test('[RED] returns 404 for unknown jobId', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request({
        method: 'GET',
        path: '/v1/pbc/jobs/job_nonexistent_xyz',
      })
      // RED: returns 404 for wrong reason (route not registered); should be 404 JOB_NOT_FOUND
      expect(response.status).toBe(404)
      const body = await fixture.json<{ error: { code: string } }>(response)
      expect(body.error.code).toMatch(/NOT_FOUND|JOB_NOT_FOUND/)
    })
  })

  test('[RED] job status field is a valid status value', async () => {
    await withWiredServer(async (fixture) => {
      const { job } = fixture.stateStore.pbcContinuationJobs.admit({
        taskId: TASK,
        workflowRef: PBC_WORKFLOW_REF,
        revisionAtAdmission: '3',
        idempotencyKey: 'job-status-check-001',
      })

      const response = await fixture.request({
        method: 'GET',
        path: `/v1/pbc/jobs/${job.jobId}`,
      })
      expect(response.status).toBe(200)
      const body = await fixture.json<Record<string, unknown>>(response)

      const validStatuses = ['queued', 'running', 'succeeded', 'failed', 'cancelled']
      expect(validStatuses).toContain(body['status'])
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §11 — POST /v1/pbc/tasks/:taskId/effects/reconcile — operator route
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /v1/pbc/tasks/:taskId/effects/reconcile — operator route (RED)', () => {
  test('[RED] returns 200 with reconcile result', async () => {
    const wrkf = makeProductFakePort({
      effectList: async () => [
        { id: 'eff-001', kind: 'set_task_state', status: 'pending' },
      ],
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/effects/reconcile`,
          body: {},
        })
        // RED: returns 404; should be 200
        expect(response.status).toBe(200)
      },
      { wrkf }
    )
  })

  test('[RED] returns 503 WRKF_UNAVAILABLE when deps.wrkf is absent', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request({
        method: 'POST',
        path: `/v1/pbc/tasks/${TASK}/effects/reconcile`,
        body: {},
      })
      expect(response.status).toBe(503)
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §12 — Route registration checks (all return non-404 when registered)
// ─────────────────────────────────────────────────────────────────────────────

describe('Route registration — all /v1/pbc/* routes are registered (RED)', () => {
  test('[RED] POST /v1/pbc/tasks/:taskId/start is registered (not 404)', async () => {
    const wrkf = makeProductFakePort()
    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/start`,
          body: { idempotencyKey: 'reg-check-start', intake: { title: 'test' } },
        })
        expect(response.status).not.toBe(404)
      },
      { wrkf }
    )
  })

  test('[RED] GET /v1/pbc/tasks/:taskId is registered (not 404)', async () => {
    const wrkf = makeProductFakePort()
    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'GET',
          path: `/v1/pbc/tasks/${TASK}`,
        })
        expect(response.status).not.toBe(404)
      },
      { wrkf }
    )
  })

  test('[RED] POST /v1/pbc/tasks/:taskId/input is registered (not 404)', async () => {
    const wrkf = makeProductFakePort()
    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/input`,
          headers: { 'x-acp-actor': HUMAN_ACTOR },
          body: {
            idempotencyKey: 'reg-check-input',
            kind: 'clarification_response',
            data: { answer: 'test' },
          },
        })
        expect(response.status).not.toBe(404)
      },
      { wrkf }
    )
  })

  test('[RED] POST /v1/pbc/tasks/:taskId/continue is registered (not 404)', async () => {
    const wrkf = makeProductFakePort()
    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/continue`,
          body: { idempotencyKey: 'reg-check-continue' },
        })
        expect(response.status).not.toBe(404)
      },
      { wrkf }
    )
  })

  test('[RED] POST /v1/pbc/tasks/:taskId/dispose is registered (not 404)', async () => {
    const wrkf = makeProductFakePort()
    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/dispose`,
          headers: { 'x-acp-actor': HUMAN_ACTOR },
          body: {
            idempotencyKey: 'reg-check-dispose',
            resolution: 'abandoned',
            reason: 'test',
          },
        })
        expect(response.status).not.toBe(404)
      },
      { wrkf }
    )
  })

  test('[RED] GET /v1/pbc/jobs/:jobId is registered (not 404)', async () => {
    await withWiredServer(async (fixture) => {
      // Pre-seed a job so the handler can return 200, not 404-for-not-found
      const { job } = fixture.stateStore.pbcContinuationJobs.admit({
        taskId: TASK,
        workflowRef: PBC_WORKFLOW_REF,
        revisionAtAdmission: '1',
        idempotencyKey: 'reg-check-job',
      })
      const response = await fixture.request({
        method: 'GET',
        path: `/v1/pbc/jobs/${job.jobId}`,
      })
      // Registered route → non-404 (200 or 404 for not-found, but NOT route-not-found 404)
      // We test both states: if job found = 200; if not = 404 with code JOB_NOT_FOUND
      // Either way, a registered route should return non-404 for a real job
      expect(response.status).not.toBe(404)
    })
  })

  test('[RED] POST /v1/pbc/tasks/:taskId/effects/reconcile is registered (not 404)', async () => {
    const wrkf = makeProductFakePort()
    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/effects/reconcile`,
          body: {},
        })
        expect(response.status).not.toBe(404)
      },
      { wrkf }
    )
  })

  test('[RED] mutating /pbc/* routes respond 403 when authorize returns deny', async () => {
    const wrkf = makeProductFakePort()
    const mutatingRoutes = [
      {
        method: 'POST',
        path: `/v1/pbc/tasks/${TASK}/start`,
        body: { idempotencyKey: 'authz-start', intake: { title: 'test' } },
      },
      {
        method: 'POST',
        path: `/v1/pbc/tasks/${TASK}/input`,
        headers: { 'x-acp-actor': HUMAN_ACTOR },
        body: {
          idempotencyKey: 'authz-input',
          kind: 'clarification_response',
          data: { answer: 'test' },
        },
      },
      {
        method: 'POST',
        path: `/v1/pbc/tasks/${TASK}/continue`,
        body: { idempotencyKey: 'authz-continue' },
      },
      {
        method: 'POST',
        path: `/v1/pbc/tasks/${TASK}/dispose`,
        headers: { 'x-acp-actor': HUMAN_ACTOR },
        body: { idempotencyKey: 'authz-dispose', resolution: 'abandoned', reason: 'test' },
      },
    ]

    await withWiredServer(
      async (fixture) => {
        for (const route of mutatingRoutes) {
          const response = await fixture.request(route)
          // With authorize → 'deny', mutating routes must return 403
          // RED: all return 404 (not registered); should be 403 once registered with authz wrapper
          expect(response.status).toBe(403)
        }
      },
      {
        wrkf,
        authorize: () => 'deny',
      }
    )
  })

  test('[RED] GET /v1/pbc/tasks/:taskId is NOT wrapped with authz (read-only)', async () => {
    const wrkf = makeProductFakePort()

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'GET',
          path: `/v1/pbc/tasks/${TASK}`,
        })
        // Read-only route: authorize=deny must not block it
        // RED: returns 404 (not registered); should be 200 (read-only, unblocked by deny)
        expect(response.status).toBe(200)
      },
      {
        wrkf,
        authorize: () => 'deny',
      }
    )
  })
})
