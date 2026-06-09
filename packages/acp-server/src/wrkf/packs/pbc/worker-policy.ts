import type { ParticipantOutput } from '../../runtime/evidence-writer.js'
import type { WorkerPolicyFn } from '../../runtime/workflow-pack.js'
import { isPbcFinalizationTransition } from './transition-policy.js'

type PbcWorkerInput = Parameters<WorkerPolicyFn>[0]

export const pbcWorkerPolicy: WorkerPolicyFn = (input: PbcWorkerInput) => {
  const state = `${input.next.instance.state.status}/${input.next.instance.state.phase}`

  if (input.next.instance.state.status === 'closed') {
    return { kind: 'stop', reason: 'closed' }
  }

  if (state === 'waiting/clarification') {
    if (input.allowSimulation !== true) {
      return { kind: 'stop', reason: 'requires_product_owner_clarification' }
    }
    return {
      kind: 'write-output',
      role: 'product_owner',
      actor: input.alternateActor ?? input.actor,
      allowSimulation: true,
      participantOutput: {
        evidence: [
          {
            kind: 'clarification_response',
            summary: 'autopilot product-owner clarification (simulation)',
          },
        ],
        satisfyObligations: [{ obligationKind: 'clarification_response', evidenceIndex: 0 }],
      },
    }
  }

  if (state === 'waiting/patch_decision') {
    if (input.allowSimulation !== true) {
      return { kind: 'stop', reason: 'requires_product_owner_patch_decision' }
    }
    return {
      kind: 'write-output',
      role: 'product_owner',
      actor: input.alternateActor ?? input.actor,
      allowSimulation: true,
      participantOutput: {
        evidence: [{ kind: 'patch_decision', facts: { route: patchRouteFromNext(input) } }],
        satisfyObligations: [{ obligationKind: 'patch_decision', evidenceIndex: 0 }],
      },
    }
  }

  if (hasFinalizationAction(input) && !hasDistinctReviewer(input)) {
    return { kind: 'stop', reason: 'requires_distinct_pressure_reviewer' }
  }

  return { kind: 'continue' }
}

function patchRouteFromNext(input: PbcWorkerInput): 'finalize' | 'revise' {
  const transitions = input.next.actions.map((action) => action.transition)
  const hasFinalize = transitions.includes('finalize_after_patch_decision')
  const hasRevise = transitions.includes('revise_after_patch_decision')
  return hasRevise && !hasFinalize ? 'revise' : 'finalize'
}

function hasFinalizationAction(input: PbcWorkerInput): boolean {
  return input.next.actions.some(
    (action) =>
      typeof action.transition === 'string' && isPbcFinalizationTransition(action.transition)
  )
}

function hasDistinctReviewer(input: PbcWorkerInput): boolean {
  return input.reviewerActor !== undefined && input.reviewerActor !== input.actor
}

export function productOwnerOutputFor(
  kind: 'clarification' | 'patch_decision',
  input: PbcWorkerInput
): ParticipantOutput {
  if (kind === 'clarification') {
    return {
      evidence: [
        {
          kind: 'clarification_response',
          summary: 'autopilot product-owner clarification (simulation)',
        },
      ],
      satisfyObligations: [{ obligationKind: 'clarification_response', evidenceIndex: 0 }],
    }
  }
  return {
    evidence: [{ kind: 'patch_decision', facts: { route: patchRouteFromNext(input) } }],
    satisfyObligations: [{ obligationKind: 'patch_decision', evidenceIndex: 0 }],
  }
}
