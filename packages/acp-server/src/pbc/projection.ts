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
import { currentRevisionWindow, latestOfKind } from '../wrkf/packs/pbc/freshness.js'
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

/**
 * Browser-safe evidence snapshot the projection builder reads to populate
 * `artifacts`. Structurally a superset of the freshness-pack snapshot, so the
 * shared revision-window/latest-of-kind helpers apply directly.
 */
export type PbcArtifactEvidence = {
  id: string
  kind: string
  data?: Record<string, unknown>
  facts?: Record<string, unknown>
  summary?: string
  actor?: unknown
}

/** A single artifact entry in PbcTaskProjection.artifacts. */
export type ArtifactView = {
  id: string
  kind: string
  data?: Record<string, unknown>
  summary?: string
  facts?: Record<string, unknown>
  actor?: unknown
}

/** wrkf evidence kind → projection artifacts key (proposal lines 887-977). */
const ARTIFACT_KIND_TO_KEY: Record<string, string> = {
  intake_metadata: 'intake',
  behavior_note: 'behaviorNote',
  pre_interview_analysis: 'preInterviewAnalysis',
  clarification_response: 'clarificationResponse',
  pbc_draft: 'draft',
  pressure_pass: 'pressurePass',
  patch_decision: 'patchDecision',
  pbc_final: 'final',
  disposition_decision: 'disposition',
}

/**
 * Kinds whose "latest" must be resolved within the CURRENT revision window
 * (after a revise loop, show the fresh draft/pressure/final — never the stale
 * pre-boundary one). Reuses packs/pbc/freshness.ts, no duplicated logic.
 */
const FRESHNESS_WINDOWED_KINDS = new Set(['pbc_draft', 'pressure_pass', 'pbc_final'])

/** The 5 product actions, in stable order, regardless of screen. */
const PRODUCT_ACTION_KINDS = [
  'continue',
  'submit_clarification',
  'submit_patch_decision',
  'dispose',
  'retry_effect_delivery',
] as const

function toArtifactView(evidence: PbcArtifactEvidence): ArtifactView {
  // start.ts writes intake_metadata with `facts: intake` (no `data`). Normalize
  // ONLY the intake artifact so its payload is first-class under `.data` like
  // every other kind (data wins when both present). Other kinds are unchanged.
  const data =
    evidence.kind === 'intake_metadata' ? (evidence.data ?? evidence.facts) : evidence.data
  return {
    id: evidence.id,
    kind: evidence.kind,
    ...(data !== undefined ? { data } : {}),
    ...(evidence.summary !== undefined ? { summary: evidence.summary } : {}),
    ...(evidence.facts !== undefined ? { facts: evidence.facts } : {}),
    ...(evidence.actor !== undefined ? { actor: evidence.actor } : {}),
  }
}

/**
 * Populate `artifacts` from the task evidence timeline. Each key carries the
 * LATEST evidence of its kind (data first-class, summary fallback). Freshness-
 * windowed kinds resolve within the current revision window.
 */
function buildArtifacts(evidence: PbcArtifactEvidence[]): Record<string, ArtifactView> {
  const out: Record<string, ArtifactView> = {}
  const freshWindow = currentRevisionWindow(evidence)
  for (const [kind, key] of Object.entries(ARTIFACT_KIND_TO_KEY)) {
    const pool = FRESHNESS_WINDOWED_KINDS.has(kind) ? freshWindow : evidence
    const latest = latestOfKind(pool, kind)
    if (latest !== undefined) {
      out[key] = toArtifactView(latest)
    }
  }
  return out
}

/**
 * Product actions with enablement derived from `screen` + pending effects.
 * Raw wrkf transition names live in diagnostics.legalTransitions, never here.
 */
function buildProductActions(
  screen: PbcScreen,
  pendingEffects: NextActionResponse['pendingEffects']
): Array<{ kind: string; enabled: boolean }> {
  const terminal = screen === 'finalized' || screen === 'disposed'
  const hasRetryableEffect = pendingEffects.some((effect) => effect.retryable === true)
  const enablement: Record<(typeof PRODUCT_ACTION_KINDS)[number], boolean> = {
    continue: screen === 'working' || screen === 'starting',
    submit_clarification: screen === 'clarification',
    submit_patch_decision: screen === 'patch_decision',
    dispose: !terminal,
    retry_effect_delivery: hasRetryableEffect,
  }
  return PRODUCT_ACTION_KINDS.map((kind) => ({
    kind,
    // Terminal screens (finalized/disposed) disable EVERY product action.
    enabled: terminal ? false : enablement[kind],
  }))
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
  /** Task evidence timeline (oldest→newest) used to populate `artifacts`. */
  evidence?: PbcArtifactEvidence[]
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
    artifacts: buildArtifacts(input.evidence ?? []),
    obligations: next.openObligations.map((obligation) => ({
      id: obligation.id,
      kind: obligation.kind,
      status: obligation.status,
    })),
    actions: buildProductActions(screen, next.pendingEffects),
    ...(input.job !== undefined ? { activeJob: projectActiveJob(input.job) } : {}),
    effects: next.pendingEffects.map((effect) => ({
      id: effect.id,
      kind: effect.kind,
      status: effect.status,
      ...(effect.retryable !== undefined ? { retryable: effect.retryable } : {}),
    })),
    diagnostics: {
      pack: 'pbc',
      revision: next.instance.revision,
      ...(contextHash !== undefined ? { contextHash } : {}),
      legalTransitions,
    },
  }
}
