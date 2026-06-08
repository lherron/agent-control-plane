import type { ChooseTransitionFn, ChooseTransitionResult } from '../../runtime/workflow-pack.js'
import type { NextActionResponse } from '../../projections.js'
import { type PbcEvidenceSnapshot, checkPbcFreshness } from './freshness.js'

type PbcTransitionInput = Parameters<ChooseTransitionFn>[0]

const DISPOSITION_PREFIX = 'dispose_from_'

const FINALIZATION_TRANSITIONS = new Set([
  'finalize_ready_pbc',
  'finalize_after_patch_decision',
])

const TRANSITIONS_BY_STATE: Record<string, string[]> = {
  'open/intake': ['normalize_feedback'],
  'active/behavior_note': [
    'ask_clarification',
    'draft_pbc',
    'dispose_from_behavior_note',
  ],
  'waiting/clarification': ['answer_clarification'],
  'active/pbc_draft': ['run_pressure_pass', 'dispose_from_pbc_draft'],
  'active/pressure': [
    'finalize_ready_pbc',
    'request_patch_decision',
    'revise_too_vague_pbc',
    'dispose_from_pressure',
  ],
  'waiting/patch_decision': ['finalize_after_patch_decision', 'revise_after_patch_decision'],
}

export const choosePbcTransition: ChooseTransitionFn = (
  input: PbcTransitionInput
): ChooseTransitionResult | undefined => {
  const current = stateKey(input.next)
  const allowed = TRANSITIONS_BY_STATE[current] ?? []
  const legal = (input.candidateTransitions ?? transitionsFromNext(input.next))
    .filter((transition) => allowed.includes(transition))
    .filter((transition) => input.allowExplicitOnly === true || !isDispositionTransition(transition))

  if (legal.length !== 1) {
    return undefined
  }

  const transition = legal[0]
  if (transition === undefined) {
    return undefined
  }

  if (requiresFreshnessCheck(transition)) {
    const freshness = checkPbcFreshness({
      evidenceTimeline: (input.evidenceTimeline ?? []).map(toPbcEvidenceSnapshot),
      transition,
    })
    if (freshness.blocked) {
      return { blocked: true, reason: freshness.reason }
    }
  }

  if (isFinalizationTransition(transition)) {
    if (
      input.reviewerActor === undefined ||
      input.reviewerActor.length === 0 ||
      input.reviewerActor === input.actor
    ) {
      return undefined
    }
    return { transition, actor: input.reviewerActor }
  }

  return transition
}

export function isPbcFinalizationTransition(transition: string): boolean {
  return FINALIZATION_TRANSITIONS.has(transition)
}

export function isPbcDispositionTransition(transition: string): boolean {
  return isDispositionTransition(transition)
}

function transitionsFromNext(next: NextActionResponse): string[] {
  return next.actions
    .filter((action) => action.kind === 'transition' || action.kind === undefined)
    .map((action) => action.transition)
    .filter((transition): transition is string => typeof transition === 'string')
}

function isFinalizationTransition(transition: string): boolean {
  return FINALIZATION_TRANSITIONS.has(transition)
}

function requiresFreshnessCheck(transition: string): boolean {
  return transition === 'run_pressure_pass' || FINALIZATION_TRANSITIONS.has(transition)
}

function toPbcEvidenceSnapshot(evidence: {
  id: string
  kind: string
  facts?: Record<string, unknown> | undefined
  data?: unknown
}): PbcEvidenceSnapshot {
  return {
    id: evidence.id,
    kind: evidence.kind,
    ...(evidence.facts !== undefined ? { facts: evidence.facts } : {}),
    ...(isRecord(evidence.data) ? { data: evidence.data } : {}),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isDispositionTransition(transition: string): boolean {
  return transition.startsWith(DISPOSITION_PREFIX)
}

function stateKey(next: NextActionResponse): string {
  return `${next.instance.state.status}/${next.instance.state.phase}`
}
