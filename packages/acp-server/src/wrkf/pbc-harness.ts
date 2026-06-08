/**
 * PBC harness compatibility wrapper.
 *
 * The old operator routes still import this module. The reusable run/apply/loop
 * mechanics now live in runtime/workflow-harness-core.ts; this file only wires
 * the PBC pack and preserves the historical request/result surface.
 */

import { pbcManifest } from './packs/pbc/manifest.js'
import { makePbcEvidencePolicy } from './packs/pbc/evidence-policy.js'
import {
  type TransitionPolicy,
  type WorkflowApproveTransitionRequest,
  type WorkflowHarnessPort,
  type WorkflowHarnessResult,
  type WorkflowRunStepRequest,
  approveWorkflowTransition,
  runWorkflowStep,
  runWorkflowUntilBlocked,
} from './runtime/workflow-harness-core.js'
import type { ChooseTransitionFn, WorkflowPack } from './runtime/workflow-pack.js'
import { type ParticipantOutput } from './pbc-evidence.js'

const WORKFLOW_REF = 'pbc-progressive-refinement@5'

const legacyRunStepPack: WorkflowPack = {
  ...pbcManifest,
  needsEvidenceTimeline: false,
  chooseTransition: chooseLegacySingleSafeTransition,
}

export type { TransitionPolicy }

export interface PbcHarnessPort extends WorkflowHarnessPort {}

export interface RunStepRequest {
  task: string
  role?: string
  actor: string
  idempotencyKey: string
  launchRuntime?: boolean
  participantOutput?: ParticipantOutput
  transitionPolicy?: TransitionPolicy
  scopeRef?: string
  laneRef?: string
}

export interface ApproveTransitionRequest {
  task: string
  transition: string
  role?: string
  actor: string
  routeKey: string
  runChecks?: boolean
}

export interface RunUntilBlockedRequest {
  task: string
  actor: string
  pressureActor?: string
  productOwnerActor?: string
  idempotencyKey: string
  maxTurns?: number
  allowDisposition?: boolean
  allowProductOwnerSimulation?: boolean
}

export interface PbcHarnessResult extends Omit<WorkflowHarnessResult, 'workflowRef'> {
  workflowRef: 'pbc-progressive-refinement@5'
}

export async function runStep(
  port: PbcHarnessPort,
  input: RunStepRequest
): Promise<PbcHarnessResult> {
  const request: WorkflowRunStepRequest = {
    task: input.task,
    ...(input.role !== undefined ? { role: input.role } : {}),
    actor: input.actor,
    idempotencyKey: input.idempotencyKey,
    ...(input.launchRuntime !== undefined ? { launchRuntime: input.launchRuntime } : {}),
    ...(input.participantOutput !== undefined ? { participantOutput: input.participantOutput } : {}),
    ...(input.transitionPolicy !== undefined ? { transitionPolicy: input.transitionPolicy } : {}),
    ...(input.scopeRef !== undefined ? { scopeRef: input.scopeRef } : {}),
    ...(input.laneRef !== undefined ? { laneRef: input.laneRef } : {}),
  }

  return asPbcResult(
    await runWorkflowStep(
      port,
      {
        workflowRef: WORKFLOW_REF,
        pack: legacyRunStepPack,
        evidencePolicy: makePbcEvidencePolicy(),
      },
      request
    )
  )
}

export async function approveTransition(
  port: PbcHarnessPort,
  input: ApproveTransitionRequest
): Promise<PbcHarnessResult> {
  const request: WorkflowApproveTransitionRequest = {
    task: input.task,
    transition: input.transition,
    ...(input.role !== undefined ? { role: input.role } : {}),
    actor: input.actor,
    routeKey: input.routeKey,
    ...(input.runChecks !== undefined ? { runChecks: input.runChecks } : {}),
  }

  return asPbcResult(
    await approveWorkflowTransition(
      port,
      {
        workflowRef: WORKFLOW_REF,
        pack: pbcManifest,
        evidencePolicy: makePbcEvidencePolicy(),
      },
      request
    )
  )
}

export async function runUntilBlocked(
  port: PbcHarnessPort,
  input: RunUntilBlockedRequest
): Promise<PbcHarnessResult> {
  return asPbcResult(
    await runWorkflowUntilBlocked(
      port,
      {
        workflowRef: WORKFLOW_REF,
        pack: pbcManifest,
        evidencePolicy: makePbcEvidencePolicy(
          input.allowProductOwnerSimulation !== undefined
            ? { allowProductOwnerSimulation: input.allowProductOwnerSimulation }
            : {}
        ),
      },
      {
        task: input.task,
        actor: input.actor,
        ...(input.pressureActor !== undefined ? { reviewerActor: input.pressureActor } : {}),
        ...(input.productOwnerActor !== undefined ? { alternateActor: input.productOwnerActor } : {}),
        idempotencyKey: input.idempotencyKey,
        ...(input.maxTurns !== undefined ? { maxTurns: input.maxTurns } : {}),
        ...(input.allowDisposition !== undefined
          ? { allowExplicitOnly: input.allowDisposition }
          : {}),
        ...(input.allowProductOwnerSimulation !== undefined
          ? { allowSimulation: input.allowProductOwnerSimulation }
          : {}),
      }
    )
  )
}

function asPbcResult(result: WorkflowHarnessResult): PbcHarnessResult {
  return result as PbcHarnessResult
}

function chooseLegacySingleSafeTransition(
  input: Parameters<ChooseTransitionFn>[0]
): ReturnType<ChooseTransitionFn> {
  const candidates = (input.candidateTransitions ?? [])
    .filter((transition) => input.allowExplicitOnly === true || !transition.startsWith('dispose_'))

  return candidates.length === 1 ? candidates[0] : undefined
}
