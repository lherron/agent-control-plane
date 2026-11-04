import type {
  ExecFlowStep,
  ExecStepResult,
  JobFlowStep,
  ProbeFlowStep,
  ProbeStepResult,
} from 'acp-core'
import type { JobStepRunRecord } from 'acp-jobs-store'

// Flow step kind guards and the typed results each kind stores on its step run.

export type AgentRunnableStep = Extract<JobFlowStep, { kind?: 'agent' | undefined }>

export function isExecStep(step: JobFlowStep): step is ExecFlowStep {
  return step.kind === 'exec'
}

export function isProbeStep(step: JobFlowStep): step is ProbeFlowStep {
  return step.kind === 'probe'
}

export function isNativeStep(step: JobFlowStep): boolean {
  return (
    step.kind === 'wrkq-task' || step.kind === 'pulpit-message' || step.kind === 'agent-dispatch'
  )
}

export function isAgentStep(step: JobFlowStep): step is AgentRunnableStep {
  return step.kind === undefined || step.kind === 'agent'
}

export function isSuccessfulExecStepResult(step: ExecFlowStep, result: ExecStepResult): boolean {
  if (result.timedOut || result.exitCode === null) {
    return false
  }
  const successExitCodes = step.exec.successExitCodes ?? [0]
  return successExitCodes.includes(result.exitCode)
}

export function readExecStepResult(stepRun: JobStepRunRecord): ExecStepResult | undefined {
  const result = stepRun.result
  if (
    result?.['kind'] !== 'exec' ||
    (typeof result['exitCode'] !== 'number' && result['exitCode'] !== null) ||
    typeof result['timedOut'] !== 'boolean'
  ) {
    return undefined
  }

  return result as unknown as ExecStepResult
}

export function readProbeStepResult(stepRun: JobStepRunRecord): ProbeStepResult | undefined {
  const result = stepRun.result
  if (
    result?.['kind'] !== 'probe' ||
    typeof result['name'] !== 'string' ||
    (result['outcome'] !== 'idle' && result['outcome'] !== 'work')
  ) {
    return undefined
  }

  return result as unknown as ProbeStepResult
}
