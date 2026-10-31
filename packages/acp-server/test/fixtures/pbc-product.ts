/**
 * Recording WRKF product-port fixture for the PBC facade contract suites.
 * Uses withWiredServer's isolated stores and real HTTP router. Historical RED
 * test titles remain stable identities; they describe regression expectations.
 *
 * Contract: pbc-progressive-refinement@9; inspect before attach; durable route
 * idempotency; human-only input/disposition; continuation admission without
 * inline HRC work; contextHash is diagnostic, never required mutation input.
 * The default next snapshot is behavior_note; overrides select other scenarios.
 *
 * Registered product routes:
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
 *   - requiredPack: 'pbc', requiredWorkflowRef: 'pbc-progressive-refinement@9'
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
 *   workflowRef: 'pbc-progressive-refinement@9'
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
 */
import type { AcpWrkfWorkflowPort } from '../../src/wrkf/port.js'

export const TASK = 'T-09100'
export const IDEMPOTENCY_KEY = 'pbc-product-test-001'
export const HUMAN_ACTOR = JSON.stringify({ kind: 'human', id: 'user:product-owner' })
export const AGENT_ACTOR = JSON.stringify({ kind: 'agent', id: 'agent:pbc-writer' })
export const PBC_WORKFLOW_REF = 'pbc-progressive-refinement@9'

// ─── Canned wrkf responses ────────────────────────────────────────────────────

export const INTAKE_NEXT = {
  instance: {
    id: 'inst-pbc-001',
    state: { status: 'active', phase: 'intake' },
    revision: 0,
    contextHash: 'sha256:ctx-intake-0',
  },
  actions: [{ id: 'normalize_feedback', transition: 'normalize_feedback', role: 'agent' }],
  blockedTransitions: [],
  openObligations: [],
  pendingEffects: [],
}

export const BEHAVIOR_NOTE_NEXT = {
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

export const CLARIFICATION_NEXT = {
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

export const PATCH_DECISION_NEXT = {
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

export const FINALIZED_NEXT = {
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

/**
 * Build a WRKF_NOT_FOUND-shaped error exactly as the REAL wrkf binary throws it
 * when `task.inspect` runs on a task that was never attached to a workflow
 * (no instance). The unit-test default used to return a no-instance object,
 * which masked the live 404 bug fixed in T-03050.
 */
export function wrkfNoInstanceError(): Error & { code: string } {
  const error = new Error('workflow instance not found') as Error & { code: string }
  error.code = 'WRKF_NOT_FOUND'
  return error
}

type FakeProductPortOverrides = {
  taskInspect?: () => Promise<unknown>
  taskAttach?: () => Promise<unknown>
  next?: () => Promise<unknown>
  evidenceAdd?: () => Promise<unknown>
  evidenceList?: () => Promise<unknown>
  transitionApply?: () => Promise<unknown>
  effectList?: () => Promise<unknown>
  effectDeliver?: () => Promise<unknown>
  obligationList?: () => Promise<unknown>
  obligationSatisfy?: () => Promise<unknown>
}

type InstrumentedProductPort = AcpWrkfWorkflowPort & { _calls: PortCall[] }

/** Build a fake product wrkf port that records all calls. */
export function makeProductFakePort(
  overrides: FakeProductPortOverrides = {}
): InstrumentedProductPort {
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
        return {
          task: { taskId: (params as Record<string, unknown>)['task'], title: 'Test PBC Task' },
        }
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
        return {
          id: `ev-${_calls.length}`,
          kind: (params as Record<string, unknown>)['kind'],
          task: TASK,
        }
      },
      list: async (params) => {
        _calls.push({ method: 'evidence.list', params })
        if (overrides.evidenceList !== undefined) return overrides.evidenceList()
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
          revision: (((params as Record<string, unknown>)['expectRevision'] as number) ?? 0) + 1,
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

export const DISPOSED_NEXT = {
  instance: {
    id: 'inst-pbc-001',
    state: { status: 'closed', phase: 'disposed' },
    revision: 8,
    contextHash: 'sha256:ctx-disposed-8',
  },
  actions: [],
  blockedTransitions: [],
  openObligations: [],
  pendingEffects: [],
}

/** A clarification gate with its matching open obligation, for human input. */
export function makeClarificationProductPort(): InstrumentedProductPort {
  return makeProductFakePort({
    next: async () => CLARIFICATION_NEXT,
    obligationList: async () => [
      { id: 'obl-clarif-1', kind: 'clarification_response', status: 'open' },
    ],
  })
}
