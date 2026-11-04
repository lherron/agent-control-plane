import type { BranchTaken, FlowNext, JobFlowStep, JobStepRunPhase } from 'acp-core'
import type { JobStepRunRecord, JobsStore } from 'acp-jobs-store'

import {
  isExecStep,
  isProbeStep,
  isSuccessfulExecStepResult,
  readExecStepResult,
  readProbeStepResult,
} from './step-kinds.js'

// Where a phase goes after a step settles: branch selection, the branchTaken
// record, and resolving the next step within the phase.

type PhaseTransition = FlowNext | 'continue'

type TerminalStepTransition = {
  transition: PhaseTransition
  branchTaken?: BranchTaken | undefined
}

export type ResolvedPhaseTransition =
  | { state: 'advance'; step: JobFlowStep | undefined }
  | { state: 'succeeded' }
  | { state: 'failed' }

export function resolveTerminalStepTransition(
  step: JobFlowStep,
  stepRun: JobStepRunRecord
): TerminalStepTransition {
  if (isExecStep(step)) {
    const result = readExecStepResult(stepRun)
    if (result?.exitCode !== null && result?.exitCode !== undefined) {
      const exitCodeTarget = step.branches?.exitCode?.[String(result.exitCode)]
      if (exitCodeTarget !== undefined) {
        return {
          transition: exitCodeTarget,
          branchTaken: { kind: 'exitCode', key: String(result.exitCode), target: exitCodeTarget },
        }
      }
    }

    if (step.branches?.default !== undefined) {
      return {
        transition: step.branches.default,
        branchTaken: { kind: 'default', key: 'default', target: step.branches.default },
      }
    }
  }

  if (isProbeStep(step)) {
    const result = readProbeStepResult(stepRun)
    if (result !== undefined) {
      const outcomeTarget = step.branches?.outcome?.[result.outcome]
      if (outcomeTarget !== undefined) {
        return {
          transition: outcomeTarget,
          branchTaken: { kind: 'outcome', key: result.outcome, target: outcomeTarget },
        }
      }
    }
  }

  if (step.next !== undefined) {
    return { transition: step.next }
  }

  if (isExecStep(step)) {
    const result = readExecStepResult(stepRun)
    return {
      transition:
        result !== undefined && isSuccessfulExecStepResult(step, result) ? 'continue' : 'fail',
    }
  }

  return { transition: stepRun.status === 'succeeded' ? 'continue' : 'fail' }
}

export function recordBranchTaken(input: {
  jobsStore: JobsStore
  jobRunId: string
  phase: JobStepRunPhase
  stepRun: JobStepRunRecord
  branchTaken?: BranchTaken | undefined
}): JobStepRunRecord {
  if (
    input.branchTaken === undefined ||
    JSON.stringify(input.stepRun.branchTaken) === JSON.stringify(input.branchTaken)
  ) {
    return input.stepRun
  }

  return input.jobsStore.jobStepRuns.updateStep(
    input.jobRunId,
    input.phase,
    input.stepRun.stepId,
    input.stepRun.attempt,
    { branchTaken: input.branchTaken }
  ).jobStepRun
}

export function resolvePhaseTransition(
  steps: readonly JobFlowStep[],
  stepById: ReadonlyMap<string, { step: JobFlowStep; index: number }>,
  step: JobFlowStep,
  transition: PhaseTransition
): ResolvedPhaseTransition {
  if (transition === 'succeed') {
    return { state: 'succeeded' }
  }
  if (transition === 'fail') {
    return { state: 'failed' }
  }
  if (transition === 'continue') {
    const current = stepById.get(step.id)
    if (current === undefined) {
      throw new Error(`flow step not found in phase: ${step.id}`)
    }
    return { state: 'advance', step: steps[current.index + 1] }
  }

  const target = stepById.get(transition)
  if (target === undefined) {
    throw new Error(`flow transition target not found in phase: ${transition}`)
  }

  return { state: 'advance', step: target.step }
}
