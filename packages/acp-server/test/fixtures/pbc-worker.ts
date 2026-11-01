// Explicit in-memory worker port, call spy, and evidence/output fixtures.
import type { PbcContinuationWorkerPort } from '../../src/pbc/worker.js'

// ---------------------------------------------------------------------------
// Minimal type aliases used in the fake port
// ---------------------------------------------------------------------------

type SpyCall = { method: string; params: unknown }

export type FakeWorkerPort = PbcContinuationWorkerPort & { _calls: SpyCall[] }

// ---------------------------------------------------------------------------
// Helpers — raw next response builder
// ---------------------------------------------------------------------------

export function makeNextRaw(
  opts: {
    status?: string
    phase?: string
    revision?: number
    contextHash?: string
    stale?: boolean
    actions?: Array<{ transition: string; role?: string }>
    openObligations?: Array<{ id: string; kind: string; status: string }>
    pendingEffects?: Array<{ id: string; kind: string; status: string }>
  } = {}
): Record<string, unknown> {
  return {
    instance: {
      state: { status: opts.status ?? 'active', phase: opts.phase ?? 'behavior_note' },
      revision: opts.revision ?? 0,
      contextHash: opts.contextHash ?? 'sha256:ctx0',
      ...(opts.stale !== undefined ? { stale: opts.stale } : {}),
    },
    actions: (opts.actions ?? []).map((a) => ({
      id: a.transition,
      transition: a.transition,
      ...(a.role !== undefined ? { role: a.role } : {}),
    })),
    blockedTransitions: [],
    openObligations: opts.openObligations ?? [],
    pendingEffects: opts.pendingEffects ?? [],
  }
}

function makeRunRecord(id: string): Record<string, unknown> {
  return { id, status: 'active' }
}

export function makeEvidenceRecord(
  id: string,
  kind: string,
  opts: { facts?: Record<string, unknown>; data?: Record<string, unknown> } = {}
): Record<string, unknown> {
  return {
    id,
    kind,
    ...(opts.facts !== undefined ? { facts: opts.facts } : {}),
    ...(opts.data !== undefined ? { data: opts.data } : {}),
    raw: {},
  }
}

function makeObligationRecord(id: string, kind: string, status: string): Record<string, unknown> {
  return { id, kind, status, raw: {} }
}

function makeEffectRecord(id: string, kind: string, status: string): Record<string, unknown> {
  return { id, kind, status, raw: {} }
}

// ---------------------------------------------------------------------------
// Fake port factory
// ---------------------------------------------------------------------------

/**
 * Build a fake PbcContinuationWorkerPort with _calls spy.
 *
 * opts.nextSequence        — successive next() calls return these in order. Repeats last.
 * opts.finalText           — text returned by getFinalAssistantText (all calls)
 * opts.finalTextByRunId    — per-acpRunId text override (takes precedence over finalText)
 * opts.finalTextSequence   — successive texts returned by getFinalAssistantText. Repeats last.
 *                            Takes precedence over finalText and finalTextByRunId.
 * opts.effects             — pending effects returned by effect.list
 * opts.evidence            — timeline returned by evidence.list
 * opts.captureStore        — pre-populated capture records (for crash/replay tests)
 * opts.transitionShouldThrow — hook to simulate crash at transition.apply
 * opts.launchRunIdSequence — successive acpRunIds returned by launchAcpRun. Repeats last.
 * opts.includeJobs         — include jobs.acquireLease / jobs.transition / jobs.renewLease spy
 *                            in the returned port (default false to preserve existing test compat)
 */
export function makeFakeWorkerPort(
  opts: {
    nextSequence?: Array<Record<string, unknown>>
    finalText?: string | undefined
    finalTextByRunId?: Record<string, string | undefined>
    finalTextSequence?: Array<string | undefined>
    effects?: Array<{ id: string; kind: string; status: string }>
    evidence?: Array<Record<string, unknown>>
    captureStore?: Record<string, unknown>
    transitionShouldThrow?: (transition: string) => Error | undefined
    launchRunIdSequence?: string[]
    includeJobs?: boolean
    obligationsForList?: Array<{ id: string; kind: string; status: string }>
    runStatus?: string
  } = {}
): FakeWorkerPort {
  const _calls: SpyCall[] = []
  const nextSeq = opts.nextSequence ?? [
    makeNextRaw({ status: 'closed', phase: 'finalized', actions: [] }),
  ]
  let nextCallIdx = 0
  const pendingEffects = opts.effects ?? []
  const evidenceTimeline: Record<string, unknown>[] = [...(opts.evidence ?? [])]
  const captureStore: Record<string, unknown> = { ...(opts.captureStore ?? {}) }
  const transitionThrow = opts.transitionShouldThrow ?? (() => undefined)
  const launchRunIds = opts.launchRunIdSequence ?? ['acp_run_fake_1']
  let launchCallIdx = 0
  let runCounter = 0
  let evidenceCounter = 0

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
        return (opts.obligationsForList ?? []).map((o) =>
          makeObligationRecord(o.id, o.kind, o.status)
        )
      },
      satisfy: async (params: { task: string; id: string; evidenceId?: string }) => {
        _calls.push({ method: 'obligation.satisfy', params })
        return makeObligationRecord(params.id, 'unknown', 'satisfied')
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
        return makeRunRecord(`wrkf_run_fake_${runCounter}`)
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
      }) => {
        _calls.push({ method: 'transition.apply', params })
        const err = transitionThrow(params.transition)
        if (err !== undefined) {
          throw err
        }
        return {
          transition: params.transition,
          revision: (params.expectRevision ?? 0) + 1,
          status: 'applied',
          raw: {},
        }
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

    launchAcpRun: async (params: {
      taskId: string
      role: string
      actor: string
      idempotencyKey: string
      prompt?: string
    }) => {
      _calls.push({ method: 'launchAcpRun', params })
      const acpRunId = launchRunIds[Math.min(launchCallIdx, launchRunIds.length - 1)]
      launchCallIdx++
      return { acpRunId: acpRunId ?? 'acp_run_default' }
    },

    getFinalAssistantText: (acpRunId: string): string | undefined => {
      // Determine result BEFORE pushing to _calls (so call-count-based indexing is correct)
      let result: string | undefined
      if (opts.finalTextSequence !== undefined) {
        const callCount = _calls.filter((c) => c.method === 'getFinalAssistantText').length
        const seq = opts.finalTextSequence
        result = callCount < seq.length ? seq[callCount] : seq[seq.length - 1]
      } else if (opts.finalTextByRunId !== undefined && acpRunId in opts.finalTextByRunId) {
        result = opts.finalTextByRunId[acpRunId]
      } else {
        result = opts.finalText
      }
      _calls.push({ method: 'getFinalAssistantText', params: { acpRunId } })
      return result
    },

    ...(opts.runStatus !== undefined
      ? {
          getRunStatus: (acpRunId: string): string | undefined => {
            _calls.push({ method: 'getRunStatus', params: { acpRunId } })
            return opts.runStatus
          },
        }
      : {}),

    ...(opts.includeJobs === true
      ? {
          jobs: {
            acquireLease: async (params: {
              jobId: string
              leaseOwner: string
              leaseExpiresAt: string
            }) => {
              _calls.push({ method: 'jobs.acquireLease', params })
              return { acquired: true, job: { jobId: params.jobId } }
            },
            transition: async (params: {
              jobId: string
              toStatus: 'succeeded' | 'failed' | 'cancelled'
              resultJson?: unknown
              errorJson?: unknown
              stopReason?: string
            }) => {
              _calls.push({ method: 'jobs.transition', params })
              return { jobId: params.jobId, status: params.toStatus }
            },
            renewLease: async (params: {
              jobId: string
              leaseOwner: string
              leaseExpiresAt: string
            }) => {
              _calls.push({ method: 'jobs.renewLease', params })
              return { jobId: params.jobId }
            },
          },
        }
      : {}),
  }
}

// ---------------------------------------------------------------------------
// Standard ParticipantOutput JSON builders for fake HRC text
// ---------------------------------------------------------------------------

export function behaviorNoteText(opts: { clarificationNeeded?: boolean } = {}): string {
  return JSON.stringify({
    evidence: [
      { kind: 'behavior_note', summary: 'user double-clicks the save button' },
      {
        kind: 'pre_interview_analysis',
        facts: { clarification_needed: opts.clarificationNeeded ?? false },
      },
    ],
  })
}

export function pbcDraftText(): string {
  return JSON.stringify({
    evidence: [
      { kind: 'pbc_draft', summary: 'draft PBC output', data: { basedOnBehaviorNoteId: 'ev_1' } },
    ],
  })
}

function pressureOutputText(draftEvidenceId: string, verdict: 'ready' | 'too_vague'): string {
  return JSON.stringify({
    evidence: [
      {
        kind: 'pressure_pass',
        facts: { verdict },
        data: { reviewedDraftEvidenceId: draftEvidenceId },
      },
    ],
  })
}

export function pressurePassText(draftEvidenceId: string): string {
  return pressureOutputText(draftEvidenceId, 'ready')
}

export function pressurePassTooVagueText(draftEvidenceId: string): string {
  return pressureOutputText(draftEvidenceId, 'too_vague')
}

export function pbcFinalText(draftId: string, pressureId: string): string {
  return JSON.stringify({
    evidence: [
      {
        kind: 'pbc_final',
        summary: 'final PBC output',
        data: { basedOnDraftEvidenceId: draftId, basedOnPressurePassEvidenceId: pressureId },
      },
    ],
  })
}

// ---------------------------------------------------------------------------
// Evidence timeline helper (for freshness guard tests)
// ---------------------------------------------------------------------------

export function freshDraftTimeline(): Record<string, unknown>[] {
  return [makeEvidenceRecord('ev_draft_1', 'pbc_draft')]
}

export function freshDraftAndPressureTimeline(): Record<string, unknown>[] {
  return [
    ...freshDraftTimeline(),
    makeEvidenceRecord('ev_pp_1', 'pressure_pass', {
      facts: { verdict: 'ready' },
      data: { reviewedDraftEvidenceId: 'ev_draft_1' },
    }),
  ]
}
