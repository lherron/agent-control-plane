/**
 * PbcTaskProjection builder (Phase 3, T-02864).
 *
 * Builds the browser-safe PbcTaskProjection (proposal lines 887-977) from the
 * generic wrkf `next` projection plus optional task metadata and an active
 * continuation job. This is the ONE shape every /v1/pbc/* route returns.
 *
 * HARD CONSTRAINTS (daedalus):
 *   - contextHash is DIAGNOSTICS-ONLY: it appears under instance.contextHash and
 *     diagnostics.contextHash, NEVER as a top-level field and NEVER as a required
 *     mutation input.
 *   - No raw transition IDs / obligation wire shapes are required mutation inputs;
 *     they appear here only as informational projection data.
 */

import type { PbcContinuationJob } from 'acp-state-store'

import { isRecord } from '../parsers/body.js'
import type { NextActionResponse } from '../wrkf/projections.js'

export const PBC_WORKFLOW_REF = 'pbc-progressive-refinement@5'

export type PbcScreen =
  | 'starting'
  | 'working'
  | 'clarification'
  | 'patch_decision'
  | 'finalized'
  | 'disposed'
  | 'blocked'
  | 'error'

export type PbcTaskProjection = {
  source: 'wrkf'
  taskId: string
  workflowRef: typeof PBC_WORKFLOW_REF
  task: Record<string, unknown>
  instance: {
    id: string
    status: string
    phase: string
    revision: number
    contextHash?: string
    stale?: boolean
  }
  screen: PbcScreen
  currentInput?: {
    kind: string
    prompt?: string
    schema: Record<string, unknown>
    defaults?: Record<string, unknown>
  }
  artifacts: Record<string, unknown>
  obligations: Array<{ id: string; kind: string; status: string; prompt?: string }>
  actions: Array<{ kind: string; enabled: boolean }>
  activeJob?: { id: string; status: string; startedAt?: string; finishedAt?: string; error?: unknown }
  effects: Array<{ id: string; kind: string; status: string; retryable?: boolean }>
  diagnostics: {
    pack: 'pbc'
    revision: number
    contextHash?: string
    legalTransitions?: string[]
    stopReason?: string
    warnings?: string[]
  }
}

/** Derive the product screen from the workflow instance status + phase. */
export function deriveScreen(status: string, phase: string): PbcScreen {
  if (status === 'closed') {
    return phase === 'disposed' ? 'disposed' : 'finalized'
  }
  if (status === 'waiting') {
    if (phase === 'clarification') {
      return 'clarification'
    }
    if (phase === 'patch_decision') {
      return 'patch_decision'
    }
    return 'working'
  }
  if (status === 'blocked' || status === 'error') {
    return status === 'error' ? 'error' : 'blocked'
  }
  if (status === 'open' || phase === 'intake') {
    return 'starting'
  }
  return 'working'
}

function currentInputForScreen(screen: PbcScreen): PbcTaskProjection['currentInput'] | undefined {
  if (screen === 'clarification') {
    return { kind: 'clarification_response', schema: {} }
  }
  if (screen === 'patch_decision') {
    return { kind: 'patch_decision', schema: {} }
  }
  return undefined
}

function projectActiveJob(job: PbcContinuationJob): NonNullable<PbcTaskProjection['activeJob']> {
  return {
    id: job.jobId,
    status: job.status,
    ...(job.startedAt !== undefined ? { startedAt: job.startedAt } : {}),
    ...(job.finishedAt !== undefined ? { finishedAt: job.finishedAt } : {}),
    ...(job.errorJson !== undefined ? { error: job.errorJson } : {}),
  }
}

function projectTaskMeta(task: unknown): Record<string, unknown> {
  if (!isRecord(task)) {
    return {}
  }
  const out: Record<string, unknown> = {}
  for (const key of ['title', 'state', 'projectId', 'containerId', 'url'] as const) {
    if (task[key] !== undefined) {
      out[key] = task[key]
    }
  }
  return out
}

export type BuildPbcTaskProjectionInput = {
  taskId: string
  next: NextActionResponse
  task?: unknown
  job?: PbcContinuationJob | undefined
}

/** Build the canonical PbcTaskProjection from generic projections + PBC context. */
export function buildPbcTaskProjection(input: BuildPbcTaskProjectionInput): PbcTaskProjection {
  const { next } = input
  const status = next.instance.state.status
  const phase = next.instance.state.phase
  const screen = deriveScreen(status, phase)
  const contextHash = next.instance.contextHash

  const legalTransitions = next.actions
    .map((action) => action.transition)
    .filter((transition): transition is string => typeof transition === 'string')

  const currentInput = currentInputForScreen(screen)

  return {
    source: 'wrkf',
    taskId: input.taskId,
    workflowRef: PBC_WORKFLOW_REF,
    task: projectTaskMeta(input.task),
    instance: {
      id: next.instance.id ?? next.instance.instanceId ?? '',
      status,
      phase,
      revision: next.instance.revision,
      ...(contextHash !== undefined ? { contextHash } : {}),
      ...(next.instance.stale !== undefined ? { stale: next.instance.stale } : {}),
    },
    screen,
    ...(currentInput !== undefined ? { currentInput } : {}),
    artifacts: {},
    obligations: next.openObligations.map((obligation) => ({
      id: obligation.id,
      kind: obligation.kind,
      status: obligation.status,
    })),
    actions: next.actions.map((action) => ({
      kind: action.transition ?? action.kind ?? action.id ?? 'unknown',
      enabled: true,
    })),
    ...(input.job !== undefined ? { activeJob: projectActiveJob(input.job) } : {}),
    effects: next.pendingEffects.map((effect) => ({
      id: effect.id,
      kind: effect.kind,
      status: effect.status,
    })),
    diagnostics: {
      pack: 'pbc',
      revision: next.instance.revision,
      ...(contextHash !== undefined ? { contextHash } : {}),
      legalTransitions,
    },
  }
}
