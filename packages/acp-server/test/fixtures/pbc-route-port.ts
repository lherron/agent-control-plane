import type { AcpWrkfWorkflowPort } from '../../src/wrkf/port.js'
import { makeFakePort } from './pbc-harness-port.js'

// Route-specific canned records and fault injection; shared capture/obligation recording
// comes from the PBC harness fixture. Each server owns its route idempotency store.
export const TASK = 'T-02099'
export const ACTOR = 'larry'
export const IDEMPOTENCY_KEY = 'pbc-route-test-001'

// Minimal wrkf next response shape
export const CANNED_NEXT = {
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
export class WrkfError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'WrkfError'
  }
}

type WrkfPortCall = { method: string; params: unknown }

type FakePbcPortOverrides = {
  next?: () => Promise<unknown>
  runStart?: () => Promise<unknown>
  transitionApply?: () => Promise<unknown>
  effectList?: () => Promise<unknown>
  effectDeliver?: () => Promise<unknown>
}

type InstrumentedPort = AcpWrkfWorkflowPort & {
  _calls: WrkfPortCall[]
  captures: {
    get(key: string): Promise<unknown>
    set(key: string, record: unknown): Promise<void>
  }
}

export function makeFakePbcPort(overrides: FakePbcPortOverrides = {}): InstrumentedPort {
  const base = makeFakePort()
  const _calls = base._calls
  const boom = (name: string) => (): never => {
    throw new Error(`fake wrkf: ${name} must not be called in this scenario`)
  }

  const port: InstrumentedPort = {
    _calls,

    captures: base.captures,

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

        return { id: `ev-${Date.now()}`, kind: 'result', task: TASK }
      },
      list: boom('evidence.list'),
      show: boom('evidence.show'),
      suggest: boom('evidence.suggest'),
    },

    obligation: {
      ...base.obligation,
      show: boom('obligation.show'),
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

        return CANNED_FINISH
      },
      fail: async (params) => {
        _calls.push({ method: 'run.fail', params })

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
