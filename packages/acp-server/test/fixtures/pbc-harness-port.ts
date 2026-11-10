import type { PbcHarnessPort } from '../../src/wrkf/pbc-harness.js'
// Recording WRKF daemon boundary for PBC harness route contracts.
import { makeEvidenceRecord, makeNextRaw as makeWorkerNextRaw } from './pbc-worker.js'

type SpyCall = { method: string; params: unknown }

export type FakePbcHarnessPort = PbcHarnessPort & { _calls: SpyCall[] }

/** Legacy harness scenarios start at open/intake, unlike worker scenarios. */
export function makeNextRaw(opts: Parameters<typeof makeWorkerNextRaw>[0] = {}) {
  return makeWorkerNextRaw({
    ...opts,
    status: opts.status ?? 'open',
    phase: opts.phase ?? 'intake',
  })
}

function makeRunRecord(id: string): Record<string, unknown> {
  return { id, status: 'active' }
}

function makeObligationRecord(id: string, kind: string, status: string): Record<string, unknown> {
  return { id, kind, status, raw: {} }
}

function makeEffectRecord(id: string, kind: string, status: string): Record<string, unknown> {
  return { id, kind, status, raw: {} }
}

function makeTransitionResult(transition: string, revision: number): Record<string, unknown> {
  return { transition, revision, status: 'applied', raw: {} }
}

/**
 * Build a fake PbcHarnessPort with `_calls` spy.
 *
 * opts.nextSequence: successive next() calls return these in order. Repeats last.
 * opts.effects: effects returned by effect.list (pending by default)
 * opts.obligations: open obligations returned by obligation.list
 * opts.captureStore: pre-populated capture records (for idempotency tests)
 */
export function makeFakePort(
  opts: {
    nextSequence?: Array<Record<string, unknown>>
    effects?: Array<{ id: string; kind: string; status: string }>
    obligations?: Array<{ id: string; kind: string; status: string }>
    captureStore?: Record<string, unknown>
    transitionShouldThrow?: (transition: string) => Error | undefined
    evidence?: Array<Record<string, unknown>>
  } = {}
): FakePbcHarnessPort {
  const _calls: SpyCall[] = []
  const nextSeq = opts.nextSequence ?? [makeNextRaw()]
  let nextCallIdx = 0
  const pendingEffects = opts.effects ?? []
  const openObligations = opts.obligations ?? []
  const captureStore: Record<string, unknown> = opts.captureStore ?? {}
  const evidenceTimeline: Record<string, unknown>[] = [...(opts.evidence ?? [])]
  let runCounter = 0
  let evidenceCounter = 0
  const transitionThrow = opts.transitionShouldThrow ?? (() => undefined)

  return {
    _calls,

    next: async (params: { task: string; role?: string }) => {
      _calls.push({ method: 'next', params })
      const response = nextSeq[Math.min(nextCallIdx, nextSeq.length - 1)]
      nextCallIdx++
      return response
    },

    evidence: {
      list: async (params: { task: string }) => {
        _calls.push({ method: 'evidence.list', params })
        return evidenceTimeline
      },
      add: async (params: {
        task: string
        kind: string
        ref?: string
        summary?: string
        facts?: Record<string, unknown>
        data?: unknown
        actor?: string
        role?: string
      }) => {
        _calls.push({ method: 'evidence.add', params })
        evidenceCounter++
        const record = makeEvidenceRecord(`ev_fake_${evidenceCounter}`, params.kind, {
          ...(params.facts !== undefined ? { facts: params.facts } : {}),
          ...(typeof params.data === 'object' && params.data !== null
            ? { data: params.data as Record<string, unknown> }
            : {}),
        })
        evidenceTimeline.push(record)
        return record
      },
    },

    obligation: {
      list: async (params: { task: string }) => {
        _calls.push({ method: 'obligation.list', params })
        return openObligations
      },
      satisfy: async (params: { task: string; id: string; evidenceId?: string }) => {
        _calls.push({ method: 'obligation.satisfy', params })
        const matched = openObligations.find((o) => o.id === params.id) ?? {
          id: params.id,
          kind: 'unknown',
          status: 'open',
        }
        return makeObligationRecord(matched.id, matched.kind, 'satisfied')
      },
    },

    run: {
      start: async (params: {
        task: string
        role: string
        actor?: unknown
        idempotencyKey?: string
        lane?: string
        deliveryRef?: string
      }) => {
        _calls.push({ method: 'run.start', params })
        runCounter++
        return makeRunRecord(`run_fake_${runCounter}`)
      },

      finish: async (params: { runId: string; status?: string; summary?: string }) => {
        _calls.push({ method: 'run.finish', params })
        return makeRunRecord(params.runId)
      },

      fail: async (params: { runId: string; summary?: string }) => {
        _calls.push({ method: 'run.fail', params })
        return makeRunRecord(params.runId)
      },

      bindExternal: async (params: Record<string, unknown>) => {
        _calls.push({ method: 'run.bindExternal', params })
        return makeRunRecord(String(params['runId'] ?? 'run_ext'))
      },
    },

    transition: {
      apply: async (params: {
        task: string
        transition: string
        role?: string
        actor?: unknown
        expectRevision?: number
        contextHash?: string
        idempotencyKey?: string
        runChecks?: boolean
        dryRun?: boolean
      }) => {
        _calls.push({ method: 'transition.apply', params })
        const err = transitionThrow(params.transition)
        if (err !== undefined) {
          throw err
        }
        return makeTransitionResult(params.transition, (params.expectRevision ?? 0) + 1)
      },
    },

    effect: {
      list: async (params: { task: string }) => {
        _calls.push({ method: 'effect.list', params })
        return pendingEffects
      },
      deliver: async (params: { effectId: string; adapter: string }) => {
        _calls.push({ method: 'effect.deliver', params })
        return makeEffectRecord(params.effectId, 'set_task_state', 'delivered')
      },
    },

    captures: {
      get: async (captureKey: string) => {
        _calls.push({ method: 'captures.get', params: { captureKey } })
        return captureStore[captureKey]
      },
      set: async (captureKey: string, record: unknown) => {
        _calls.push({ method: 'captures.set', params: { captureKey, record } })
        captureStore[captureKey] = record
      },
    },
  }
}
