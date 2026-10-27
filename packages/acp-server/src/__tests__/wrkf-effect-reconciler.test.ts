/**
 * RED TESTS — W5: wrkf lease effect reconciler (T-01935)
 *
 * All tests in this file fail at module-load time because
 * packages/acp-server/src/integration/wrkf-effect-reconciler.ts does not exist yet.
 * Bun throws CannotFindModule at the import below → every test is RED.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IMPL CONTRACT — what must be created to go green:
 *
 * File: packages/acp-server/src/integration/wrkf-effect-reconciler.ts
 *
 *   export type WrkfEffectReconcileDeps = {
 *     wrkf: AcpWrkfWorkflowPort
 *     coordStore: CoordinationStore
 *     taskId: string
 *     projectId: string
 *     roleBindings: Record<string, { kind: string; id: string }>
 *   }
 *
 *   export type WrkfEffectReconcileResult = {
 *     scanned: number
 *     delivered: Array<{ effectId: string; kind: string }>
 *     failed: Array<{ effectId: string; kind: string; reason: string; retryable: boolean }>
 *   }
 *
 *   export async function reconcileWrkfEffects(
 *     deps: WrkfEffectReconcileDeps
 *   ): Promise<WrkfEffectReconcileResult>
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IMPL SEQUENCE:
 *   Supported kinds: 'wake_role', 'request_observer_review'
 *
 *   1. wrkf.effect.claim({adapter:'acp', kind:'wake_role', task:taskId, limit:50, leaseMs:60000})
 *      → {effects:WrkfEffect[], leaseToken:string|null, leaseExpiresAt:string|null}
 *   2. For each wake_role effect:
 *      a. Parse payload: {kind:'wake_role', role:string, reason?:string, data?:{instruction?,...}}
 *      b. Validate payload.role (non-empty string); on failure: wrkf.effect.fail({effectId, leaseToken, retryable:false, reason:'unsupported_effect_kind'})
 *      c. Resolve actor from roleBindings[payload.role]; build sessionRef:
 *           `agent:${actor.id}:project:${projectId}:task:${taskId}:role:${payload.role}`
 *      d. appendEvent(coordStore, {
 *           projectId,
 *           idempotencyKey: effect.idempotencyKey,
 *           event: {kind:'attention.requested', semanticSession:sessionRef, ...},
 *           wake: {sessionRef, reason: payload.reason ?? defaultReason, dedupeKey: effect.idempotencyKey}
 *         })
 *      e. On appendEvent adapter error: wrkf.effect.fail({effectId, leaseToken, retryable:true})
 *      f. On success: wrkf.effect.ack({effectId, leaseToken})
 *   3. wrkf.effect.claim({adapter:'acp', kind:'request_observer_review', task:taskId, ...})
 *      → same flow; payload.data.instruction goes into event content body;
 *        payload.data.guardrails goes into event meta
 *
 * CRITICAL (C-03525): ACP claims PER-SUPPORTED-KIND. NEVER issue a blanket claim
 *   (no kind filter). ACP owns 'wake_role' and 'request_observer_review' ONLY.
 *   Foreign kinds (e.g. 'launch_participant_run') must remain untouched.
 *   'unsupported_effect_kind' fail is DEFENSIVE-ONLY for malformed claimed payloads.
 *
 * WIRING (workflow-tasks.ts:184,332):
 *   enqueueWrkfEffectDeliveryTick(taskId) must call reconcileWrkfEffects, not be a no-op.
 *   After wrkf transition.apply there must be NO call to reconcileWorkflowEffectIntents.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'
import {
  type CoordinationStore,
  listEvents,
  listPendingWakes,
  openCoordinationStore,
} from 'coordination-substrate'

import { withWiredServer } from '../../test/fixtures/wired-server.js'
import { reconcileWrkfEffects } from '../integration/wrkf-effect-reconciler.js'

import type { AcpWrkfWorkflowPort } from '../wrkf/port.js'

// ─── Shared fixture data ──────────────────────────────────────────────────────

const TASK_ID = 'T-WRKF05'
const PROJECT_ID = 'P-wrkf05-test'

const ROLE_BINDINGS: Record<string, { kind: string; id: string }> = {
  architect: { kind: 'agent', id: 'cody' },
  implementer: { kind: 'agent', id: 'larry' },
  red_author: { kind: 'agent', id: 'smokey' },
  coordinator: { kind: 'agent', id: 'clod' },
  observer: { kind: 'agent', id: 'daedalus' },
}

// ─── Real effect payload shapes (authoritative — from real-run-effects fixtures + C-03525) ────

/**
 * Minimal wake_role payload: only kind + role.
 * Matches real eff_000001/eff_000002 in real-run-effects-before-ack.json.
 */
const WAKE_ROLE_PAYLOAD_MINIMAL = {
  kind: 'wake_role',
  role: 'architect',
} as const

/**
 * Full wake_role payload: kind + role + reason + data.instruction.
 * Matches real eff_000008 from live wrkq.db (captured 2026-06-05).
 */
const WAKE_ROLE_PAYLOAD_FULL = {
  kind: 'wake_role',
  role: 'coordinator',
  reason: 'observer_rejected_completion_claim',
  data: {
    instruction:
      'Read latest observer_completion_review, perform remediation, then submit a revised completion_claim.',
  },
} as const

/**
 * Full request_observer_review payload (authoritative shape from hook-catalog.wrapped.json).
 * role MUST be 'observer'; data contains guardrails, instruction, targetLane.
 */
const REQUEST_OBSERVER_REVIEW_PAYLOAD = {
  kind: 'request_observer_review',
  role: 'observer',
  reason: 'completion_claim_ready_for_external_review',
  data: {
    targetLane: 'observer',
    instruction: 'Audit the latest completion_claim against the original task body and evidence.',
    guardrails: [
      'Judge against the original task body, not the coordinator’s self-authored criteria alone.',
      'Do not accept bypassed functionality as complete without an explicit human/supervisor override.',
    ],
  },
} as const

// ─── Effect object factories ──────────────────────────────────────────────────

type WrkfEffect = {
  id: string
  instanceId: string
  revision: number
  kind: string
  payload: Record<string, unknown>
  status: string
  idempotencyKey: string
  attempts: number
  leasedBy?: string
  leasedUntil?: string
  createdAt: string
  updatedAt: string
}

function makeEffect(
  overrides: Partial<WrkfEffect> & { id: string; kind: string; payload: Record<string, unknown> }
): WrkfEffect {
  return {
    instanceId: `wfi_${TASK_ID.toLowerCase()}_test`,
    revision: 4,
    status: 'leased',
    idempotencyKey: `wfi_${TASK_ID.toLowerCase()}_test:4:test_transition:${overrides.id}`,
    attempts: 1,
    leasedBy: 'acp',
    leasedUntil: '2099-01-01T00:00:00Z',
    createdAt: '2026-06-05T10:00:00Z',
    updatedAt: '2026-06-05T10:01:00Z',
    ...overrides,
  }
}

const WAKE_ROLE_EFFECT_MINIMAL = makeEffect({
  id: 'eff_w5_001',
  kind: 'wake_role',
  payload: { ...WAKE_ROLE_PAYLOAD_MINIMAL },
  idempotencyKey: `wfi_${TASK_ID.toLowerCase()}_test:4:test_architect_wake:eff_w5_001`,
})

const WAKE_ROLE_EFFECT_FULL = makeEffect({
  id: 'eff_w5_002',
  kind: 'wake_role',
  payload: { ...WAKE_ROLE_PAYLOAD_FULL },
  revision: 8,
  idempotencyKey: `wfi_${TASK_ID.toLowerCase()}_test:8:test_coordinator_wake:eff_w5_002`,
})

const OBSERVER_REVIEW_EFFECT = makeEffect({
  id: 'eff_w5_003',
  kind: 'request_observer_review',
  payload: { ...REQUEST_OBSERVER_REVIEW_PAYLOAD },
  revision: 6,
  idempotencyKey: `wfi_${TASK_ID.toLowerCase()}_test:6:submit_completion_1:eff_w5_003`,
})

// ─── Claim response helpers ───────────────────────────────────────────────────

// Real wrkf ALWAYS returns a non-null leaseToken from claim (even for empty effects).
// The reconciler MUST check effects.length to detect empty claims, not leaseToken.
type ClaimResponse = {
  effects: WrkfEffect[]
  leaseToken: string // always a string (real wrkf confirmed 2026-06-05)
  leaseExpiresAt: string // always a string
}

const LEASE_TOKEN_A = 'lease_aaaa1111bbbb2222cccc3333dddd4444'
const LEASE_TOKEN_B = 'lease_bbbb2222cccc3333dddd4444eeee5555'

function claimedResponse(effects: WrkfEffect[], leaseToken = LEASE_TOKEN_A): ClaimResponse {
  return {
    effects,
    leaseToken: effects.length > 0 ? leaseToken : null,
    leaseExpiresAt: effects.length > 0 ? '2099-01-01T00:00:00Z' : null,
  }
}

// NOTE: Real wrkf ALWAYS returns a non-null leaseToken, even for empty claims.
// The reconciler must use effects.length === 0 to detect empty claims, NOT check leaseToken.
const EMPTY_CLAIM: ClaimResponse = {
  effects: [],
  leaseToken: 'lease_empty_00000000000000000000000000000000',
  leaseExpiresAt: '2099-01-01T00:00:00Z',
}

// ─── Fake wrkf port ───────────────────────────────────────────────────────────

type WrkfCall = { method: string; params: unknown }

type FakeEffectOverrides = {
  claimByKind?: Record<string, () => Promise<unknown>>
  ackOverride?: (params: Record<string, unknown>) => Promise<unknown>
  failOverride?: (params: Record<string, unknown>) => Promise<unknown>
  /** Role bindings wrkf.task.inspect reports (the production binding source). */
  inspectRoleBindings?: Record<string, { kind: string; id: string }>
}

type InstrumentedWrkfPort = AcpWrkfWorkflowPort & { _calls: WrkfCall[] }

function makeFakeWrkfPort(overrides: FakeEffectOverrides = {}): InstrumentedWrkfPort {
  const _calls: WrkfCall[] = []
  const boom = (name: string) => (): never => {
    throw new Error(`fake wrkf: ${name} must not be called in this test scenario`)
  }

  return {
    _calls,
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
        return {
          id: `wfi_${(params as { task: string }).task.toLowerCase()}_test`,
          taskRef: `wrkq:${(params as { task: string }).task}`,
          projectId: PROJECT_ID,
          status: 'active',
          phase: 'doing',
          revision: 5,
          ...(overrides.inspectRoleBindings !== undefined
            ? { roleBindings: overrides.inspectRoleBindings }
            : {}),
        }
      },
      timeline: async (params) => {
        _calls.push({ method: 'task.timeline', params })
        return []
      },
      refresh: boom('task.refresh'),
      syncMeta: boom('task.syncMeta'),
    },
    next: boom('next'),
    evidence: {
      add: boom('evidence.add'),
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
        return []
      },
      show: boom('obligation.show'),
      satisfy: boom('obligation.satisfy'),
      waive: boom('obligation.waive'),
      cancel: boom('obligation.cancel'),
    },
    transition: { apply: boom('transition.apply') },
    run: {
      start: boom('run.start'),
      bindExternal: boom('run.bindExternal'),
      finish: boom('run.finish'),
      fail: boom('run.fail'),
      show: boom('run.show'),
      list: async (params) => {
        _calls.push({ method: 'run.list', params })
        return []
      },
    },
    effect: {
      list: async (params) => {
        _calls.push({ method: 'effect.list', params })
        return { effects: [] }
      },
      show: boom('effect.show'),
      claim: async (params) => {
        _calls.push({ method: 'effect.claim', params })
        const p = params as Record<string, unknown>
        const kind = p['kind'] as string | undefined
        if (kind !== undefined && overrides.claimByKind?.[kind] !== undefined) {
          return overrides.claimByKind[kind]!()
        }
        return EMPTY_CLAIM
      },
      ack: async (params) => {
        _calls.push({ method: 'effect.ack', params })
        if (overrides.ackOverride !== undefined) {
          return overrides.ackOverride(params as Record<string, unknown>)
        }
        return { effectId: (params as Record<string, unknown>)['effectId'], status: 'delivered' }
      },
      fail: async (params) => {
        _calls.push({ method: 'effect.fail', params })
        if (overrides.failOverride !== undefined) {
          return overrides.failOverride(params as Record<string, unknown>)
        }
        return { effectId: (params as Record<string, unknown>)['effectId'], status: 'failed' }
      },
      retry: boom('effect.retry'),
      deliver: boom('effect.deliver'),
    },
  } as InstrumentedWrkfPort
}

// ─── Coordination store fixture ────────────────────────────────────────────────

type CoordFixture = { coordStore: CoordinationStore; cleanup: () => void }

function openCoordFixture(): CoordFixture {
  const dir = mkdtempSync(join(tmpdir(), 'acp-wrkf-effect-test-'))
  const dbPath = join(dir, 'coord.db')
  const coordStore = openCoordinationStore(dbPath)
  return {
    coordStore,
    cleanup: () => {
      coordStore.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

// ─── Base deps factory ────────────────────────────────────────────────────────

function makeBaseDeps(wrkf: InstrumentedWrkfPort, coordStore: CoordinationStore) {
  return {
    wrkf,
    coordStore,
    taskId: TASK_ID,
    projectId: PROJECT_ID,
    roleBindings: ROLE_BINDINGS,
  }
}

/**
 * Production-shaped deps: the sole production caller (enqueueWrkfEffectDeliveryTick)
 * passes only wrkf/coordStore/taskId; projectId and role bindings come from
 * wrkf.task.inspect.
 */
function makeProductionDeps(wrkf: InstrumentedWrkfPort, coordStore: CoordinationStore) {
  return { wrkf, coordStore, taskId: TASK_ID }
}

const INSPECT_ROLE_BINDINGS = {
  architect: { kind: 'agent', id: 'cody' },
  coordinator: { kind: 'agent', id: 'clod' },
  // Differs from the built-in default ('observer') so the test proves inspect is read.
  observer: { kind: 'agent', id: 'daedalus' },
}

function sessionRefFor(agentId: string, role: string) {
  return {
    scopeRef: `agent:${agentId}:project:${PROJECT_ID}:task:${TASK_ID}:role:${role}`,
    laneRef: 'main',
  }
}

const DELIVERY_CASES = [
  { name: 'wake_role', kind: 'wake_role', effect: WAKE_ROLE_EFFECT_MINIMAL },
  {
    name: 'request_observer_review',
    kind: 'request_observer_review',
    effect: OBSERVER_REVIEW_EFFECT,
  },
] as const

// ═════════════════════════════════════════════════════════════════════════════
// Section 0: REAL-SHAPE guard
//
// Verifies the reconciler reads REAL effect payload shapes (matching
// real-run-effects fixtures + C-03525 authoritative shapes).
// ═════════════════════════════════════════════════════════════════════════════

describe('Section 0 — REAL-SHAPE guard: reconciler reads real effect payload fields (W5 red)', () => {
  test('wake_role effect with payload.reason sets that reason on the pending wake', async () => {
    // payload.reason = 'observer_rejected_completion_claim' must reach the wake record
    const { coordStore, cleanup } = openCoordFixture()
    try {
      const wrkf = makeFakeWrkfPort({
        claimByKind: {
          wake_role: async () => claimedResponse([WAKE_ROLE_EFFECT_FULL]),
        },
      })

      await reconcileWrkfEffects(makeBaseDeps(wrkf, coordStore))

      const wakes = listPendingWakes(coordStore, { projectId: PROJECT_ID })
      const wake = wakes[0]!
      expect(wake.reason).toBe(WAKE_ROLE_PAYLOAD_FULL.reason)
    } finally {
      cleanup()
    }
  })

  test('[RED] request_observer_review: data.instruction carried into coordination event content', async () => {
    const { coordStore, cleanup } = openCoordFixture()
    try {
      const wrkf = makeFakeWrkfPort({
        claimByKind: {
          request_observer_review: async () => claimedResponse([OBSERVER_REVIEW_EFFECT]),
        },
      })

      await reconcileWrkfEffects(makeBaseDeps(wrkf, coordStore))

      // The coordination event should carry the instruction from data.instruction
      const events = listEvents(coordStore, { projectId: PROJECT_ID, taskId: TASK_ID })
      expect(events.length).toBeGreaterThanOrEqual(1)

      const event = events[0]!
      const contentStr = JSON.stringify(event.content)
      expect(contentStr).toContain(REQUEST_OBSERVER_REVIEW_PAYLOAD.data.instruction.slice(0, 40))
    } finally {
      cleanup()
    }
  })

  test('request_observer_review carries data.guardrails into the coordination event meta', async () => {
    const { coordStore, cleanup } = openCoordFixture()
    try {
      const wrkf = makeFakeWrkfPort({
        claimByKind: {
          request_observer_review: async () => claimedResponse([OBSERVER_REVIEW_EFFECT]),
        },
      })

      await reconcileWrkfEffects(makeBaseDeps(wrkf, coordStore))

      const events = listEvents(coordStore, { projectId: PROJECT_ID, taskId: TASK_ID })
      const event = events[0]!
      expect((event.meta as Record<string, unknown>)['guardrails']).toEqual(
        REQUEST_OBSERVER_REVIEW_PAYLOAD.data.guardrails
      )
    } finally {
      cleanup()
    }
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Section 1: Per-kind claim isolation
//
// ACP must claim EXACTLY 'wake_role' and 'request_observer_review' by kind.
// NEVER a blanket (no-kind) claim. Foreign kinds must be left untouched.
// ═════════════════════════════════════════════════════════════════════════════

describe('Section 1 — Per-kind claim isolation: ACP claims only its supported kinds (W5 red)', () => {
  test('ACP claims exactly wake_role then request_observer_review, adapter "acp", scoped to the task (no blanket drain)', async () => {
    const { coordStore, cleanup } = openCoordFixture()
    try {
      const wrkf = makeFakeWrkfPort()
      await reconcileWrkfEffects(makeBaseDeps(wrkf, coordStore))

      const claimParams = wrkf._calls
        .filter((c) => c.method === 'effect.claim')
        .map((c) => c.params)
      expect(claimParams).toEqual([
        { adapter: 'acp', kind: 'wake_role', task: TASK_ID, limit: 50, leaseMs: 60_000 },
        {
          adapter: 'acp',
          kind: 'request_observer_review',
          task: TASK_ID,
          limit: 50,
          leaseMs: 60_000,
        },
      ])
    } finally {
      cleanup()
    }
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Section 2: Lease single-delivery
// ═════════════════════════════════════════════════════════════════════════════

describe('Section 2 — Lease single-delivery (W5 red)', () => {
  test('empty claim responses deliver nothing: no ack, no fail, no coordination event or wake', async () => {
    const { coordStore, cleanup } = openCoordFixture()
    try {
      const wrkf = makeFakeWrkfPort() // default: all claims return EMPTY_CLAIM
      await reconcileWrkfEffects(makeBaseDeps(wrkf, coordStore))

      expect(wrkf._calls.filter((c) => c.method === 'effect.ack')).toHaveLength(0)
      expect(wrkf._calls.filter((c) => c.method === 'effect.fail')).toHaveLength(0)
      expect(listEvents(coordStore, { projectId: PROJECT_ID })).toHaveLength(0)
      expect(listPendingWakes(coordStore, { projectId: PROJECT_ID })).toHaveLength(0)
    } finally {
      cleanup()
    }
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Section 3: ack requires matching lease token
// ═════════════════════════════════════════════════════════════════════════════

describe('Section 3 — ack uses matching lease token from claim (W5 red)', () => {
  test("each acked effect carries its own claim batch's lease token and effectId", async () => {
    const { coordStore, cleanup } = openCoordFixture()
    try {
      const wrkf = makeFakeWrkfPort({
        claimByKind: {
          wake_role: async () => claimedResponse([WAKE_ROLE_EFFECT_MINIMAL], LEASE_TOKEN_A),
          request_observer_review: async () =>
            claimedResponse([OBSERVER_REVIEW_EFFECT], LEASE_TOKEN_B),
        },
      })

      await reconcileWrkfEffects(makeBaseDeps(wrkf, coordStore))

      const ackParams = wrkf._calls.filter((c) => c.method === 'effect.ack').map((c) => c.params)
      expect(ackParams).toEqual([
        { effectId: WAKE_ROLE_EFFECT_MINIMAL.id, leaseToken: LEASE_TOKEN_A },
        { effectId: OBSERVER_REVIEW_EFFECT.id, leaseToken: LEASE_TOKEN_B },
      ])
      expect(wrkf._calls.filter((c) => c.method === 'effect.fail')).toHaveLength(0)
    } finally {
      cleanup()
    }
  })

  test('[RED] wrkf.effect.ack rejection propagates as an error (mismatched/expired token)', async () => {
    const { coordStore, cleanup } = openCoordFixture()
    try {
      const wrkf = makeFakeWrkfPort({
        claimByKind: {
          wake_role: async () => claimedResponse([WAKE_ROLE_EFFECT_MINIMAL], LEASE_TOKEN_A),
        },
        ackOverride: async () => {
          throw new Error('WRKF_LEASE_EXPIRED: lease token mismatch or expired')
        },
      })

      await expect(reconcileWrkfEffects(makeBaseDeps(wrkf, coordStore))).rejects.toThrow(
        'WRKF_LEASE_EXPIRED'
      )
    } finally {
      cleanup()
    }
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Section 4: fail marks retryable vs non-retryable
//
// - appendEvent adapter error → fail(retryable:true) — transient infra failure
// - missing/malformed payload.role → fail(retryable:false, reason:'unsupported_effect_kind')
// ═════════════════════════════════════════════════════════════════════════════

describe('Section 4 — fail retryable vs non-retryable (W5 red)', () => {
  test.each([
    { name: 'missing payload.role', payload: { kind: 'wake_role' } },
    { name: 'empty payload', payload: {} },
  ])(
    '$name → fail(retryable:false, reason:"unsupported_effect_kind") and no ack',
    async ({ payload }) => {
      const { coordStore, cleanup } = openCoordFixture()
      try {
        const malformedEffect = makeEffect({
          id: 'eff_malformed_001',
          kind: 'wake_role',
          payload: payload as Record<string, unknown>,
          idempotencyKey: 'wfi_test:1:bad:eff_malformed_001',
        })
        const wrkf = makeFakeWrkfPort({
          claimByKind: {
            wake_role: async () => claimedResponse([malformedEffect], LEASE_TOKEN_A),
          },
        })

        await reconcileWrkfEffects(makeBaseDeps(wrkf, coordStore))

        const failCalls = wrkf._calls.filter((c) => c.method === 'effect.fail')
        expect(failCalls).toHaveLength(1)
        const p = failCalls[0]!.params as Record<string, unknown>
        expect(p['effectId']).toBe(malformedEffect.id)
        expect(p['leaseToken']).toBe(LEASE_TOKEN_A)
        expect(p['retryable']).toBe(false)
        expect(p['reason']).toBe('unsupported_effect_kind')
        expect(wrkf._calls.filter((c) => c.method === 'effect.ack')).toHaveLength(0)
      } finally {
        cleanup()
      }
    }
  )

  test('[RED] appendEvent throws → fail(retryable:true)', async () => {
    // Simulates a transient coordination store error (e.g. DB locked).
    // The reconciler should fail the effect as retryable so it can be retried.
    //
    // NOTE: This test uses a broken coordStore simulation via a wrapping approach.
    // We make appendEvent throw by providing invalid projectId that causes coordStore to reject.
    // Alternatively, we verify that if appendEvent throws, fail(retryable:true) is called.
    const { coordStore, cleanup } = openCoordFixture()
    try {
      const wrkf = makeFakeWrkfPort({
        claimByKind: {
          wake_role: async () => claimedResponse([WAKE_ROLE_EFFECT_MINIMAL], LEASE_TOKEN_A),
        },
      })

      // Inject a broken coordStore that throws on any operation
      const brokenCoordStore = new Proxy(coordStore, {
        get(target, prop) {
          if (prop === 'sqlite') {
            return new Proxy(target.sqlite, {
              get(_target, sqliteProp) {
                if (sqliteProp === 'transaction') {
                  return () => () => {
                    throw new Error('SQLITE_BUSY: database is locked')
                  }
                }
                return Reflect.get(_target, sqliteProp)
              },
            })
          }
          return Reflect.get(target, prop)
        },
      })

      await reconcileWrkfEffects({
        wrkf,
        coordStore: brokenCoordStore as CoordinationStore,
        taskId: TASK_ID,
        projectId: PROJECT_ID,
        roleBindings: ROLE_BINDINGS,
      })

      const failCalls = wrkf._calls.filter((c) => c.method === 'effect.fail')
      expect(failCalls).toHaveLength(1)
      const p = failCalls[0]!.params as Record<string, unknown>
      expect(p['effectId']).toBe(WAKE_ROLE_EFFECT_MINIMAL.id)
      expect(p['leaseToken']).toBe(LEASE_TOKEN_A)
      expect(p['retryable']).toBe(true)
    } finally {
      cleanup()
    }
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Section 5: delivery — attention.requested + wake, idempotent on effect.idempotencyKey.
// Both supported kinds share one delivery path, so these are tables over kind.
// ═════════════════════════════════════════════════════════════════════════════

describe('Section 5 — wake_role delivery: attention.requested + wake, idempotent (W5 red)', () => {
  test.each(DELIVERY_CASES)(
    "delivered $name effect's pending wake uses effect.idempotencyKey as its dedupeKey",
    async ({ kind, effect }) => {
      const { coordStore, cleanup } = openCoordFixture()
      try {
        const wrkf = makeFakeWrkfPort({
          claimByKind: { [kind]: async () => claimedResponse([effect]) },
        })

        await reconcileWrkfEffects(makeBaseDeps(wrkf, coordStore))

        const wakes = listPendingWakes(coordStore, { projectId: PROJECT_ID })
        expect(wakes).toHaveLength(1)
        expect(wakes[0]!.dedupeKey).toBe(effect.idempotencyKey)
      } finally {
        cleanup()
      }
    }
  )

  test.each(DELIVERY_CASES)(
    're-delivering the same claimed $name effect appends exactly one attention.requested event',
    async ({ kind, effect }) => {
      const { coordStore, cleanup } = openCoordFixture()
      try {
        const wrkf = makeFakeWrkfPort({
          claimByKind: { [kind]: async () => claimedResponse([effect]) },
        })

        await reconcileWrkfEffects(makeBaseDeps(wrkf, coordStore))
        await reconcileWrkfEffects(makeBaseDeps(wrkf, coordStore))

        const events = listEvents(coordStore, { projectId: PROJECT_ID, taskId: TASK_ID })
        const attentionEvents = events.filter((e) => e.kind === 'attention.requested')
        expect(attentionEvents).toHaveLength(1)
      } finally {
        cleanup()
      }
    }
  )

  test.each([
    {
      name: 'minimal wake_role (architect)',
      kind: 'wake_role',
      effect: WAKE_ROLE_EFFECT_MINIMAL,
      expected: sessionRefFor('cody', 'architect'),
    },
    {
      name: 'full wake_role reads payload.role, not effect.kind (coordinator)',
      kind: 'wake_role',
      effect: WAKE_ROLE_EFFECT_FULL,
      expected: sessionRefFor('clod', 'coordinator'),
    },
    {
      name: 'request_observer_review (observer bound via inspect)',
      kind: 'request_observer_review',
      effect: OBSERVER_REVIEW_EFFECT,
      expected: sessionRefFor('daedalus', 'observer'),
    },
  ])(
    'wake sessionRef targets the bound agent for payload.role on this task: $name',
    async ({ kind, effect, expected }) => {
      const { coordStore, cleanup } = openCoordFixture()
      try {
        const wrkf = makeFakeWrkfPort({
          claimByKind: { [kind]: async () => claimedResponse([effect]) },
          inspectRoleBindings: INSPECT_ROLE_BINDINGS,
        })

        await reconcileWrkfEffects(makeProductionDeps(wrkf, coordStore))

        const wakes = listPendingWakes(coordStore, { projectId: PROJECT_ID })
        expect(wakes).toHaveLength(1)
        expect(wakes[0]!.sessionRef).toEqual(expected)
      } finally {
        cleanup()
      }
    }
  )
})

// ═════════════════════════════════════════════════════════════════════════════
// Section 7: wiring
//
// A successful wrkf transition must trigger reconcileWrkfEffects (via
// enqueueWrkfEffectDeliveryTick), observed as outbound per-kind effect claims.
// ═════════════════════════════════════════════════════════════════════════════

describe('Section 7 — wiring: enqueueWrkfEffectDeliveryTick calls reconcileWrkfEffects (W5 red)', () => {
  test('wrkf transition via POST /v1/tasks/:id/transitions triggers per-kind effect claims', async () => {
    // After W5: enqueueWrkfEffectDeliveryTick must call reconcileWrkfEffects which calls
    // wrkf.effect.claim. Currently it is a no-op → wrkf.effect.claim never called → RED.
    const effectClaimCalls: Array<Record<string, unknown>> = []

    // waitFor: poll for async side-effect (enqueueWrkfEffectDeliveryTick is fire-and-forget)
    async function waitForClaim(timeoutMs = 200): Promise<void> {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (effectClaimCalls.length >= 2) return
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
    }

    const fakeWrkf: AcpWrkfWorkflowPort = {
      workflow: {
        validate: async () => ({}),
        show: async () => ({}),
        list: async () => [],
        diff: async () => ({}),
        install: async () => ({}),
      },
      task: {
        attach: async () => ({}),
        inspect: async () => ({
          id: 'wfi_t-wrkf05_test',
          taskRef: `wrkq:${TASK_ID}`,
          projectId: PROJECT_ID,
          status: 'active',
          phase: 'doing',
          revision: 3,
        }),
        timeline: async () => [],
        refresh: async () => ({}),
        syncMeta: async () => ({}),
      },
      next: async () => ({
        instance: { id: 'wfi_t-wrkf05_test', revision: 3, stale: false },
        actions: [],
        blockedTransitions: [],
        openObligations: [],
        pendingEffects: [],
      }),
      evidence: {
        add: async () => ({}),
        list: async () => [],
        show: async () => ({}),
        suggest: async () => ({}),
      },
      obligation: {
        list: async () => [],
        show: async () => ({}),
        satisfy: async () => ({}),
        waive: async () => ({}),
        cancel: async () => ({}),
      },
      transition: {
        apply: async () => ({
          taskId: TASK_ID,
          transitionId: 'test_transition',
          status: 'ok',
        }),
      },
      run: {
        start: async () => ({}),
        bindExternal: async () => ({}),
        finish: async () => ({}),
        fail: async () => ({}),
        show: async () => ({}),
        list: async () => [],
      },
      effect: {
        list: async () => ({ effects: [] }),
        show: async () => ({}),
        claim: async (params) => {
          effectClaimCalls.push(params as Record<string, unknown>)
          return EMPTY_CLAIM
        },
        ack: async () => ({}),
        fail: async () => ({}),
        retry: async () => ({}),
        deliver: async () => ({}),
      },
    }

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/tasks/${TASK_ID}/transitions`,
          body: {
            transitionId: 'test_transition',
            role: 'coordinator',
            actor: { agentId: 'clod' },
            idempotencyKey: 'wrkf-wiring-test-001',
          },
        })

        // Transition should succeed
        expect(response.status).toBe(200)

        // Wait for async effect delivery tick
        await waitForClaim()

        // After W5: wrkf.effect.claim must have been called with kind:'wake_role'
        // Currently (W3): enqueueWrkfEffectDeliveryTick is a no-op → claim never called → RED
        expect(effectClaimCalls.map((p) => [p['adapter'], p['kind']])).toEqual([
          ['acp', 'wake_role'],
          ['acp', 'request_observer_review'],
        ])
      },
      { wrkf: fakeWrkf }
    )
  })
})
