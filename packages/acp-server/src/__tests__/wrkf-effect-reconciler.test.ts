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

// ─── Type alias for the reconciler result ────────────────────────────────────
type ReconcileResult = {
  scanned: number
  delivered: Array<{ effectId: string; kind: string }>
  failed: Array<{ effectId: string; kind: string; reason: string; retryable: boolean }>
}

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

// ═════════════════════════════════════════════════════════════════════════════
// Section 0: REAL-SHAPE guard
//
// Verifies the reconciler correctly reads REAL effect payload shapes from the
// canned responses (matching real-run-effects fixtures + C-03525 authoritative shapes).
// These tests use canned claim responses with the REAL payload structures and
// assert that appendEvent is called with the correctly parsed values.
//
// These tests are RED because wrkf-effect-reconciler.ts does not exist.
// They go GREEN when the impl reads the REAL payload fields (not legacy field names).
// ═════════════════════════════════════════════════════════════════════════════

describe('Section 0 — REAL-SHAPE guard: reconciler reads real effect payload fields (W5 red)', () => {
  test('[RED] wake_role minimal payload: role extracted and used in wake sessionRef', async () => {
    const { coordStore, cleanup } = openCoordFixture()
    try {
      const wrkf = makeFakeWrkfPort({
        claimByKind: {
          wake_role: async () => claimedResponse([WAKE_ROLE_EFFECT_MINIMAL]),
        },
      })

      await reconcileWrkfEffects(makeBaseDeps(wrkf, coordStore))

      const wakes = listPendingWakes(coordStore, { projectId: PROJECT_ID })
      expect(wakes.length).toBeGreaterThanOrEqual(1)

      // The wake sessionRef must contain the role from the payload ('architect')
      const wake = wakes[0]!
      const sessionRefStr = JSON.stringify(wake.sessionRef)
      expect(sessionRefStr).toContain('architect')
      expect(sessionRefStr).toContain(TASK_ID)
    } finally {
      cleanup()
    }
  })

  test('[RED] wake_role payload.role is read from effect.payload.role (not effect.kind)', async () => {
    // Validates that the reconciler reads `payload.role` (e.g. 'coordinator'), not `effect.kind` ('wake_role')
    const { coordStore, cleanup } = openCoordFixture()
    try {
      const wrkf = makeFakeWrkfPort({
        claimByKind: {
          wake_role: async () => claimedResponse([WAKE_ROLE_EFFECT_FULL]),
        },
      })

      await reconcileWrkfEffects(makeBaseDeps(wrkf, coordStore))

      const wakes = listPendingWakes(coordStore, { projectId: PROJECT_ID })
      expect(wakes.length).toBeGreaterThanOrEqual(1)

      // sessionRef must reference 'coordinator' (payload.role), not 'wake_role' (effect.kind)
      const wake = wakes[0]!
      const sessionRefStr = JSON.stringify(wake.sessionRef)
      expect(sessionRefStr).toContain('coordinator')
      expect(sessionRefStr).not.toContain('wake_role')
    } finally {
      cleanup()
    }
  })

  test('[RED] wake_role full payload: reason from payload.reason appears in wake.reason', async () => {
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

  test('[RED] request_observer_review: role is observer, data fields accessible', async () => {
    // payload.role MUST be 'observer'; data.instruction and data.guardrails MUST be read
    const { coordStore, cleanup } = openCoordFixture()
    try {
      const wrkf = makeFakeWrkfPort({
        claimByKind: {
          request_observer_review: async () => claimedResponse([OBSERVER_REVIEW_EFFECT]),
        },
      })

      await reconcileWrkfEffects(makeBaseDeps(wrkf, coordStore))

      const wakes = listPendingWakes(coordStore, { projectId: PROJECT_ID })
      expect(wakes.length).toBeGreaterThanOrEqual(1)

      // sessionRef must reference 'observer' role
      const wake = wakes[0]!
      const sessionRefStr = JSON.stringify(wake.sessionRef)
      expect(sessionRefStr).toContain('observer')
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

  test('[RED] request_observer_review: data.guardrails carried into event meta', async () => {
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
      const metaStr = JSON.stringify(event.meta)
      expect(metaStr).toContain('guardrails')
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
  test('[RED] effect.claim is called with {adapter:"acp", kind:"wake_role"}', async () => {
    const { coordStore, cleanup } = openCoordFixture()
    try {
      const wrkf = makeFakeWrkfPort()
      await reconcileWrkfEffects(makeBaseDeps(wrkf, coordStore))

      const claimCalls = wrkf._calls.filter((c) => c.method === 'effect.claim')
      const wakeRoleClaim = claimCalls.find(
        (c) => (c.params as Record<string, unknown>)['kind'] === 'wake_role'
      )
      expect(wakeRoleClaim).toBeDefined()
      const p = wakeRoleClaim!.params as Record<string, unknown>
      expect(p['adapter']).toBe('acp')
      expect(p['kind']).toBe('wake_role')
    } finally {
      cleanup()
    }
  })

  test('[RED] effect.claim is called with {adapter:"acp", kind:"request_observer_review"}', async () => {
    const { coordStore, cleanup } = openCoordFixture()
    try {
      const wrkf = makeFakeWrkfPort()
      await reconcileWrkfEffects(makeBaseDeps(wrkf, coordStore))

      const claimCalls = wrkf._calls.filter((c) => c.method === 'effect.claim')
      const observerClaim = claimCalls.find(
        (c) => (c.params as Record<string, unknown>)['kind'] === 'request_observer_review'
      )
      expect(observerClaim).toBeDefined()
      const p = observerClaim!.params as Record<string, unknown>
      expect(p['adapter']).toBe('acp')
      expect(p['kind']).toBe('request_observer_review')
    } finally {
      cleanup()
    }
  })

  test('[RED] effect.claim is NEVER called without a kind filter (no blanket drain)', async () => {
    // ACP must NEVER issue a blanket claim that would steal foreign-kind effects.
    const { coordStore, cleanup } = openCoordFixture()
    try {
      const wrkf = makeFakeWrkfPort()
      await reconcileWrkfEffects(makeBaseDeps(wrkf, coordStore))

      const claimCalls = wrkf._calls.filter((c) => c.method === 'effect.claim')
      const blanketClaim = claimCalls.find(
        (c) => (c.params as Record<string, unknown>)['kind'] === undefined
      )
      expect(blanketClaim).toBeUndefined()
    } finally {
      cleanup()
    }
  })

  test('[RED] task filter is included in claim params to scope to the given taskId', async () => {
    const { coordStore, cleanup } = openCoordFixture()
    try {
      const wrkf = makeFakeWrkfPort()
      await reconcileWrkfEffects(makeBaseDeps(wrkf, coordStore))

      const claimCalls = wrkf._calls.filter((c) => c.method === 'effect.claim')
      for (const call of claimCalls) {
        const p = call.params as Record<string, unknown>
        // Every claim must be scoped to the task; a missing task param could drain foreign tasks
        expect(p['task']).toBe(TASK_ID)
      }
    } finally {
      cleanup()
    }
  })

  test('[RED] only supported kinds are claimed: exactly two claim calls (wake_role, request_observer_review)', async () => {
    const { coordStore, cleanup } = openCoordFixture()
    try {
      const wrkf = makeFakeWrkfPort()
      await reconcileWrkfEffects(makeBaseDeps(wrkf, coordStore))

      const claimCalls = wrkf._calls.filter((c) => c.method === 'effect.claim')
      const kinds = claimCalls.map((c) => (c.params as Record<string, unknown>)['kind'])
      expect(kinds).toContain('wake_role')
      expect(kinds).toContain('request_observer_review')
      // There should be no extra kinds beyond the two supported ones
      const unsupportedClaims = kinds.filter(
        (k) => k !== 'wake_role' && k !== 'request_observer_review'
      )
      expect(unsupportedClaims).toHaveLength(0)
    } finally {
      cleanup()
    }
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Section 2: Lease single-delivery
//
// One leaseToken per claimed batch. ack uses that exact token.
// Empty claim response → no delivery attempt, no ack/fail.
// ═════════════════════════════════════════════════════════════════════════════

describe('Section 2 — Lease single-delivery (W5 red)', () => {
  test('[RED] empty claim response: no ack or fail is called', async () => {
    // Both claims return empty → nothing to deliver
    const { coordStore, cleanup } = openCoordFixture()
    try {
      const wrkf = makeFakeWrkfPort() // default: all claims return EMPTY_CLAIM
      const result = (await reconcileWrkfEffects(makeBaseDeps(wrkf, coordStore))) as ReconcileResult

      const ackCalls = wrkf._calls.filter((c) => c.method === 'effect.ack')
      const failCalls = wrkf._calls.filter((c) => c.method === 'effect.fail')
      expect(ackCalls).toHaveLength(0)
      expect(failCalls).toHaveLength(0)
      expect(result.scanned).toBe(0)
    } finally {
      cleanup()
    }
  })

  test('[RED] scanned count reflects number of claimed effects across both kinds', async () => {
    const { coordStore, cleanup } = openCoordFixture()
    try {
      const wrkf = makeFakeWrkfPort({
        claimByKind: {
          wake_role: async () => claimedResponse([WAKE_ROLE_EFFECT_MINIMAL, WAKE_ROLE_EFFECT_FULL]),
          request_observer_review: async () => claimedResponse([OBSERVER_REVIEW_EFFECT]),
        },
      })

      const result = (await reconcileWrkfEffects(makeBaseDeps(wrkf, coordStore))) as ReconcileResult
      expect(result.scanned).toBe(3)
    } finally {
      cleanup()
    }
  })

  test('[RED] ack is called once per delivered effect (not zero, not twice)', async () => {
    const { coordStore, cleanup } = openCoordFixture()
    try {
      const wrkf = makeFakeWrkfPort({
        claimByKind: {
          wake_role: async () => claimedResponse([WAKE_ROLE_EFFECT_MINIMAL]),
        },
      })

      await reconcileWrkfEffects(makeBaseDeps(wrkf, coordStore))

      const ackCalls = wrkf._calls.filter((c) => c.method === 'effect.ack')
      expect(ackCalls).toHaveLength(1)
    } finally {
      cleanup()
    }
  })

  test('[RED] concurrent reconcilers: only one batch is fully acked (second claim returns empty)', async () => {
    // Simulates two reconcilers running concurrently against the same task.
    // The wrkf lease ensures only one gets the effects.
    let firstClaimServed = false
    const { coordStore, cleanup } = openCoordFixture()
    try {
      const wrkf1 = makeFakeWrkfPort({
        claimByKind: {
          wake_role: async () => {
            firstClaimServed = true
            return claimedResponse([WAKE_ROLE_EFFECT_MINIMAL], LEASE_TOKEN_A)
          },
        },
      })
      const wrkf2 = makeFakeWrkfPort({
        claimByKind: {
          // Second reconciler gets empty (wrkf already leased to first)
          wake_role: async () => EMPTY_CLAIM,
        },
      })

      const { coordStore: coordStore2, cleanup: cleanup2 } = openCoordFixture()
      try {
        await Promise.all([
          reconcileWrkfEffects(makeBaseDeps(wrkf1, coordStore)),
          reconcileWrkfEffects(makeBaseDeps(wrkf2, coordStore2)),
        ])

        const ackCalls1 = wrkf1._calls.filter((c) => c.method === 'effect.ack')
        const ackCalls2 = wrkf2._calls.filter((c) => c.method === 'effect.ack')
        expect(ackCalls1).toHaveLength(1)
        expect(ackCalls2).toHaveLength(0)
        expect(firstClaimServed).toBe(true)
      } finally {
        cleanup2()
      }
    } finally {
      cleanup()
    }
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Section 3: ack requires matching lease token
//
// The ack call must use the exact leaseToken returned by the claim response.
// ═════════════════════════════════════════════════════════════════════════════

describe('Section 3 — ack uses matching lease token from claim (W5 red)', () => {
  test('[RED] ack is called with the effectId from the claimed effect', async () => {
    const { coordStore, cleanup } = openCoordFixture()
    try {
      const wrkf = makeFakeWrkfPort({
        claimByKind: {
          wake_role: async () => claimedResponse([WAKE_ROLE_EFFECT_MINIMAL], LEASE_TOKEN_A),
        },
      })

      await reconcileWrkfEffects(makeBaseDeps(wrkf, coordStore))

      const ackCalls = wrkf._calls.filter((c) => c.method === 'effect.ack')
      expect(ackCalls).toHaveLength(1)
      const p = ackCalls[0]!.params as Record<string, unknown>
      expect(p['effectId']).toBe(WAKE_ROLE_EFFECT_MINIMAL.id)
    } finally {
      cleanup()
    }
  })

  test('[RED] ack is called with the leaseToken from the claim response (not a hardcoded value)', async () => {
    const { coordStore, cleanup } = openCoordFixture()
    try {
      const wrkf = makeFakeWrkfPort({
        claimByKind: {
          wake_role: async () => claimedResponse([WAKE_ROLE_EFFECT_MINIMAL], LEASE_TOKEN_A),
        },
      })

      await reconcileWrkfEffects(makeBaseDeps(wrkf, coordStore))

      const ackCalls = wrkf._calls.filter((c) => c.method === 'effect.ack')
      const p = ackCalls[0]!.params as Record<string, unknown>
      expect(p['leaseToken']).toBe(LEASE_TOKEN_A)
    } finally {
      cleanup()
    }
  })

  test('[RED] ack uses leaseToken from the SPECIFIC batch (wake_role vs request_observer_review get different tokens)', async () => {
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

      const ackCalls = wrkf._calls.filter((c) => c.method === 'effect.ack')
      expect(ackCalls).toHaveLength(2)

      const wakeRoleAck = ackCalls.find(
        (c) => (c.params as Record<string, unknown>)['effectId'] === WAKE_ROLE_EFFECT_MINIMAL.id
      )
      const observerAck = ackCalls.find(
        (c) => (c.params as Record<string, unknown>)['effectId'] === OBSERVER_REVIEW_EFFECT.id
      )

      expect((wakeRoleAck!.params as Record<string, unknown>)['leaseToken']).toBe(LEASE_TOKEN_A)
      expect((observerAck!.params as Record<string, unknown>)['leaseToken']).toBe(LEASE_TOKEN_B)
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
//   This is DEFENSIVE-ONLY since we only claim our supported kinds.
// ═════════════════════════════════════════════════════════════════════════════

describe('Section 4 — fail retryable vs non-retryable (W5 red)', () => {
  test('[RED] missing payload.role → fail(retryable:false, reason:"unsupported_effect_kind")', async () => {
    // Defensive: if a claimed effect has a malformed payload, fail non-retryably.
    const { coordStore, cleanup } = openCoordFixture()
    try {
      const malformedEffect = makeEffect({
        id: 'eff_malformed_001',
        kind: 'wake_role',
        payload: { kind: 'wake_role' }, // role field is MISSING
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
    } finally {
      cleanup()
    }
  })

  test('[RED] null payload → fail(retryable:false, reason:"unsupported_effect_kind")', async () => {
    const { coordStore, cleanup } = openCoordFixture()
    try {
      const nullPayloadEffect = makeEffect({
        id: 'eff_null_payload_001',
        kind: 'wake_role',
        payload: {} as Record<string, unknown>, // empty payload
        idempotencyKey: 'wfi_test:1:null_payload:eff_null_payload_001',
      })
      const wrkf = makeFakeWrkfPort({
        claimByKind: {
          wake_role: async () => claimedResponse([nullPayloadEffect], LEASE_TOKEN_A),
        },
      })

      await reconcileWrkfEffects(makeBaseDeps(wrkf, coordStore))

      const failCalls = wrkf._calls.filter((c) => c.method === 'effect.fail')
      expect(failCalls).toHaveLength(1)
      const p = failCalls[0]!.params as Record<string, unknown>
      expect(p['retryable']).toBe(false)
      expect(p['reason']).toBe('unsupported_effect_kind')
    } finally {
      cleanup()
    }
  })

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

  test('[RED] malformed payload → fail is called, ack is NOT called', async () => {
    const { coordStore, cleanup } = openCoordFixture()
    try {
      const badEffect = makeEffect({
        id: 'eff_bad_002',
        kind: 'wake_role',
        payload: { kind: 'wake_role' }, // missing role
        idempotencyKey: 'wfi_test:2:bad:eff_bad_002',
      })
      const wrkf = makeFakeWrkfPort({
        claimByKind: {
          wake_role: async () => claimedResponse([badEffect], LEASE_TOKEN_A),
        },
      })

      await reconcileWrkfEffects(makeBaseDeps(wrkf, coordStore))

      const ackCalls = wrkf._calls.filter((c) => c.method === 'effect.ack')
      const failCalls = wrkf._calls.filter((c) => c.method === 'effect.fail')
      expect(ackCalls).toHaveLength(0)
      expect(failCalls).toHaveLength(1)
    } finally {
      cleanup()
    }
  })

  test('[RED] successful delivery: ack is called, fail is NOT called', async () => {
    const { coordStore, cleanup } = openCoordFixture()
    try {
      const wrkf = makeFakeWrkfPort({
        claimByKind: {
          wake_role: async () => claimedResponse([WAKE_ROLE_EFFECT_MINIMAL], LEASE_TOKEN_A),
        },
      })

      await reconcileWrkfEffects(makeBaseDeps(wrkf, coordStore))

      const ackCalls = wrkf._calls.filter((c) => c.method === 'effect.ack')
      const failCalls = wrkf._calls.filter((c) => c.method === 'effect.fail')
      expect(ackCalls).toHaveLength(1)
      expect(failCalls).toHaveLength(0)
    } finally {
      cleanup()
    }
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Section 5: wake_role delivery
//
// wake_role appends attention.requested event + wake request idempotently.
// The wake is keyed on payload.role and uses effect.idempotencyKey.
// ═════════════════════════════════════════════════════════════════════════════

describe('Section 5 — wake_role delivery: attention.requested + wake, idempotent (W5 red)', () => {
  test('[RED] wake_role appends an attention.requested event to coordStore', async () => {
    const { coordStore, cleanup } = openCoordFixture()
    try {
      const wrkf = makeFakeWrkfPort({
        claimByKind: {
          wake_role: async () => claimedResponse([WAKE_ROLE_EFFECT_MINIMAL]),
        },
      })

      await reconcileWrkfEffects(makeBaseDeps(wrkf, coordStore))

      const events = listEvents(coordStore, { projectId: PROJECT_ID })
      expect(events.length).toBeGreaterThanOrEqual(1)
      const attentionEvent = events.find((e) => e.kind === 'attention.requested')
      expect(attentionEvent).toBeDefined()
    } finally {
      cleanup()
    }
  })

  test('[RED] wake_role creates a wake request in coordStore', async () => {
    const { coordStore, cleanup } = openCoordFixture()
    try {
      const wrkf = makeFakeWrkfPort({
        claimByKind: {
          wake_role: async () => claimedResponse([WAKE_ROLE_EFFECT_MINIMAL]),
        },
      })

      await reconcileWrkfEffects(makeBaseDeps(wrkf, coordStore))

      const wakes = listPendingWakes(coordStore, { projectId: PROJECT_ID })
      expect(wakes.length).toBeGreaterThanOrEqual(1)
    } finally {
      cleanup()
    }
  })

  test('[RED] wake_role wake.dedupeKey equals effect.idempotencyKey (for dedup guard)', async () => {
    const { coordStore, cleanup } = openCoordFixture()
    try {
      const wrkf = makeFakeWrkfPort({
        claimByKind: {
          wake_role: async () => claimedResponse([WAKE_ROLE_EFFECT_MINIMAL]),
        },
      })

      await reconcileWrkfEffects(makeBaseDeps(wrkf, coordStore))

      const wakes = listPendingWakes(coordStore, { projectId: PROJECT_ID })
      const wake = wakes[0]!
      expect(wake.dedupeKey).toBe(WAKE_ROLE_EFFECT_MINIMAL.idempotencyKey)
    } finally {
      cleanup()
    }
  })

  test('[RED] wake_role coordination event has idempotencyKey = effect.idempotencyKey', async () => {
    const { coordStore, cleanup } = openCoordFixture()
    try {
      const wrkf = makeFakeWrkfPort({
        claimByKind: {
          wake_role: async () => claimedResponse([WAKE_ROLE_EFFECT_MINIMAL]),
        },
      })

      await reconcileWrkfEffects(makeBaseDeps(wrkf, coordStore))

      // Second call with same idempotencyKey must return the same event (idempotent)
      await reconcileWrkfEffects(makeBaseDeps(wrkf, coordStore))

      // Only ONE event should exist (idempotency via idempotencyKey)
      const events = listEvents(coordStore, {
        projectId: PROJECT_ID,
        taskId: TASK_ID,
      })
      const attentionEvents = events.filter((e) => e.kind === 'attention.requested')
      expect(attentionEvents).toHaveLength(1)
    } finally {
      cleanup()
    }
  })

  test('[RED] wake_role sessionRef contains the role from payload.role and the taskId', async () => {
    const { coordStore, cleanup } = openCoordFixture()
    try {
      const wrkf = makeFakeWrkfPort({
        claimByKind: {
          wake_role: async () => claimedResponse([WAKE_ROLE_EFFECT_MINIMAL]),
        },
      })

      await reconcileWrkfEffects(makeBaseDeps(wrkf, coordStore))

      const wakes = listPendingWakes(coordStore, { projectId: PROJECT_ID })
      const wake = wakes[0]!
      const sessionRefStr = JSON.stringify(wake.sessionRef)
      expect(sessionRefStr).toContain('architect') // payload.role
      expect(sessionRefStr).toContain(TASK_ID)
    } finally {
      cleanup()
    }
  })

  test('[RED] wake_role sessionRef contains the bound agent id from roleBindings', async () => {
    const { coordStore, cleanup } = openCoordFixture()
    try {
      const wrkf = makeFakeWrkfPort({
        claimByKind: {
          wake_role: async () => claimedResponse([WAKE_ROLE_EFFECT_MINIMAL]),
        },
      })

      await reconcileWrkfEffects(makeBaseDeps(wrkf, coordStore))

      const wakes = listPendingWakes(coordStore, { projectId: PROJECT_ID })
      const wake = wakes[0]!
      const sessionRefStr = JSON.stringify(wake.sessionRef)
      // roleBindings['architect'].id = 'cody'
      expect(sessionRefStr).toContain('cody')
    } finally {
      cleanup()
    }
  })

  test('[RED] wake_role result contains delivered effectId and kind', async () => {
    const { coordStore, cleanup } = openCoordFixture()
    try {
      const wrkf = makeFakeWrkfPort({
        claimByKind: {
          wake_role: async () => claimedResponse([WAKE_ROLE_EFFECT_MINIMAL]),
        },
      })

      const result = (await reconcileWrkfEffects(makeBaseDeps(wrkf, coordStore))) as ReconcileResult

      expect(result.delivered).toHaveLength(1)
      expect(result.delivered[0]!.effectId).toBe(WAKE_ROLE_EFFECT_MINIMAL.id)
      expect(result.delivered[0]!.kind).toBe('wake_role')
      expect(result.failed).toHaveLength(0)
    } finally {
      cleanup()
    }
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Section 6: request_observer_review delivery
//
// Treated as wake of role='observer'. Carries data.instruction and
// data.guardrails into the coordination event. Idempotent on idempotencyKey.
// ═════════════════════════════════════════════════════════════════════════════

describe('Section 6 — request_observer_review delivery: observer wake with data (W5 red)', () => {
  test('[RED] request_observer_review creates wake request for observer role', async () => {
    const { coordStore, cleanup } = openCoordFixture()
    try {
      const wrkf = makeFakeWrkfPort({
        claimByKind: {
          request_observer_review: async () => claimedResponse([OBSERVER_REVIEW_EFFECT]),
        },
      })

      await reconcileWrkfEffects(makeBaseDeps(wrkf, coordStore))

      const wakes = listPendingWakes(coordStore, { projectId: PROJECT_ID })
      expect(wakes.length).toBeGreaterThanOrEqual(1)

      const wake = wakes[0]!
      const sessionRefStr = JSON.stringify(wake.sessionRef)
      expect(sessionRefStr).toContain('observer')
      // roleBindings['observer'].id = 'daedalus'
      expect(sessionRefStr).toContain('daedalus')
    } finally {
      cleanup()
    }
  })

  test('[RED] request_observer_review uses effect.idempotencyKey for dedup', async () => {
    const { coordStore, cleanup } = openCoordFixture()
    try {
      const wrkf = makeFakeWrkfPort({
        claimByKind: {
          request_observer_review: async () => claimedResponse([OBSERVER_REVIEW_EFFECT]),
        },
      })

      await reconcileWrkfEffects(makeBaseDeps(wrkf, coordStore))

      const wakes = listPendingWakes(coordStore, { projectId: PROJECT_ID })
      const wake = wakes[0]!
      expect(wake.dedupeKey).toBe(OBSERVER_REVIEW_EFFECT.idempotencyKey)
    } finally {
      cleanup()
    }
  })

  test('[RED] request_observer_review is idempotent: second call does not create a second wake', async () => {
    const { coordStore, cleanup } = openCoordFixture()
    try {
      const wrkf = makeFakeWrkfPort({
        claimByKind: {
          request_observer_review: async () => claimedResponse([OBSERVER_REVIEW_EFFECT]),
        },
      })

      await reconcileWrkfEffects(makeBaseDeps(wrkf, coordStore))
      await reconcileWrkfEffects(makeBaseDeps(wrkf, coordStore))

      const events = listEvents(coordStore, { projectId: PROJECT_ID, taskId: TASK_ID })
      const attentionEvents = events.filter((e) => e.kind === 'attention.requested')
      expect(attentionEvents).toHaveLength(1)
    } finally {
      cleanup()
    }
  })

  test('[RED] request_observer_review result has delivered entry with correct kind', async () => {
    const { coordStore, cleanup } = openCoordFixture()
    try {
      const wrkf = makeFakeWrkfPort({
        claimByKind: {
          request_observer_review: async () => claimedResponse([OBSERVER_REVIEW_EFFECT]),
        },
      })

      const result = (await reconcileWrkfEffects(makeBaseDeps(wrkf, coordStore))) as ReconcileResult
      expect(result.delivered).toHaveLength(1)
      expect(result.delivered[0]!.effectId).toBe(OBSERVER_REVIEW_EFFECT.id)
      expect(result.delivered[0]!.kind).toBe('request_observer_review')
    } finally {
      cleanup()
    }
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Section 7: wiring expectations
//
// After W5 is implemented and wired, a successful wrkf transition must trigger
// reconcileWrkfEffects (via enqueueWrkfEffectDeliveryTick), and the old
// reconcileWorkflowEffectIntents must NOT be called after wrkf transitions.
//
// These tests use withWiredServer + fake wrkf port to observe side effects.
// Currently RED because enqueueWrkfEffectDeliveryTick is a no-op (W3 placeholder).
// ═════════════════════════════════════════════════════════════════════════════

describe('Section 7 — wiring: enqueueWrkfEffectDeliveryTick calls reconcileWrkfEffects (W5 red)', () => {
  test('[RED] POST /v1/tasks/:taskId/transitions with wrkf: effect.claim is called with wake_role kind', async () => {
    // After W5: enqueueWrkfEffectDeliveryTick must call reconcileWrkfEffects which calls
    // wrkf.effect.claim. Currently it is a no-op → wrkf.effect.claim never called → RED.
    const effectClaimCalls: Array<Record<string, unknown>> = []

    // waitFor: poll for async side-effect (enqueueWrkfEffectDeliveryTick is fire-and-forget)
    async function waitForClaim(timeoutMs = 200): Promise<void> {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (effectClaimCalls.length > 0) return
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
        const wakeRoleClaim = effectClaimCalls.find((p) => p['kind'] === 'wake_role')
        expect(wakeRoleClaim).toBeDefined()
        expect(wakeRoleClaim!['adapter']).toBe('acp')
      },
      { wrkf: fakeWrkf }
    )
  })

  test('[RED] POST /v1/tasks/:taskId/transitions with wrkf: effect.claim called for request_observer_review too', async () => {
    const effectClaimCalls: Array<Record<string, unknown>> = []

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
        inspect: async () => ({ projectId: PROJECT_ID, status: 'active', revision: 2 }),
        timeline: async () => [],
        refresh: async () => ({}),
        syncMeta: async () => ({}),
      },
      next: async () => ({
        instance: { revision: 2, stale: false },
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
        apply: async () => ({ taskId: TASK_ID, status: 'ok' }),
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
            idempotencyKey: 'wrkf-wiring-test-002',
          },
        })
        expect(response.status).toBe(200)

        await waitForClaim()

        const observerClaim = effectClaimCalls.find((p) => p['kind'] === 'request_observer_review')
        expect(observerClaim).toBeDefined()
        expect(observerClaim!['adapter']).toBe('acp')
      },
      { wrkf: fakeWrkf }
    )
  })

  test('[RED] wrkf transition does NOT trigger stateStore listPendingEffectIntents (old reconciler not called)', async () => {
    // After W5: reconcileWorkflowEffectIntents must NOT be called after a wrkf transition.
    // If the old reconciler is called, it would call stateStore.workflowRuntime.listPendingEffectIntents.
    // We verify this by confirming 0 effects are ever queued via the ACP state store path.
    //
    // This test is verifying a negative: that the old reconciler pathway is not invoked
    // after a wrkf transition. Currently, the old reconciler IS NOT called for wrkf
    // transitions (the code is correct), but after W5 we want to ensure the new
    // reconciler is wired in its place (tested above) and the old one stays absent.
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
        inspect: async () => ({ projectId: PROJECT_ID, status: 'active', revision: 1 }),
        timeline: async () => [],
        refresh: async () => ({}),
        syncMeta: async () => ({}),
      },
      next: async () => ({
        instance: { revision: 1, stale: false },
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
        apply: async () => ({ taskId: TASK_ID, status: 'ok' }),
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
        claim: async () => EMPTY_CLAIM,
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
            idempotencyKey: 'wrkf-wiring-test-003',
          },
        })
        expect(response.status).toBe(200)

        // The ACP state store should have ZERO workflow effect intents after a wrkf transition.
        // The old reconcileWorkflowEffectIntents path (via listPendingEffectIntents) must not be called.
        const pending = fixture.stateStore.workflowRuntime.listPendingEffectIntents(100)
        expect(pending).toHaveLength(0)
      },
      { wrkf: fakeWrkf }
    )
  })
})
