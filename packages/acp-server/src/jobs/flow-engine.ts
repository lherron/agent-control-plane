import type { Actor, JobFlowStep, JobStepRunPhase } from 'acp-core'
import {
  type JobRecord,
  type JobRunRecord,
  type JobStepRunRecord,
  type JobsStore,
  formatJobFlowValidationErrors,
  validateJobFlowJob,
} from 'acp-jobs-store'

import type { ResolvedAcpServerDeps } from '../deps.js'
import { advanceAgentStep } from './flow/advance-agent.js'
import { advanceExecStep } from './flow/advance-exec.js'
import { advanceNativeStep } from './flow/advance-native.js'
import { advanceProbeStep } from './flow/advance-probe.js'
import { describeFailedStep } from './flow/failure-summary.js'
import { isAgentStep, isExecStep, isNativeStep, isProbeStep } from './flow/step-kinds.js'
import {
  type StepAdvanceInput,
  type StepAdvanceResult,
  TERMINAL_STEP_STATUSES,
  currentStepRun,
  readJobRun,
  requireJobsStore,
  requireStepRun,
} from './flow/step-runs.js'
import {
  type ResolvedPhaseTransition,
  recordBranchTaken,
  resolvePhaseTransition,
  resolveTerminalStepTransition,
} from './flow/transitions.js'

// Advances one job run through its flow as far as it can go now: walks the
// sequence phase (and onFailure after a failure), advancing each step by kind,
// and settles the job run, or leaves it dispatched while an agent step's run is
// still in flight.

export type AdvanceJobFlowInput = {
  deps: ResolvedAcpServerDeps
  job: JobRecord
  jobRun: JobRunRecord
  now?: string | undefined
  actor?: Actor | undefined
}

type PhaseAdvanceResult =
  | Exclude<ResolvedPhaseTransition, { state: 'advance' }>
  | { state: 'blocked' }

export async function advanceJobFlow(input: AdvanceJobFlowInput): Promise<JobRunRecord> {
  const flow = input.job.flow
  if (flow === undefined) {
    throw new Error(`job flow is required for ${input.job.jobId}`)
  }

  const validation = validateJobFlowJob(
    {
      triggerKind: input.job.trigger.kind,
      schedule: input.job.trigger.kind === 'schedule' ? input.job.schedule : undefined,
      flow,
    },
    { allowInputFile: false }
  )
  if (!validation.valid) {
    throw new Error(
      `invalid job flow for ${input.job.jobId}: ${formatJobFlowValidationErrors(validation.errors)}`
    )
  }

  const jobsStore = requireJobsStore(input.deps)
  const actor = input.actor ?? input.deps.defaultActor
  const now = input.now ?? new Date().toISOString()

  ensureStepRows(jobsStore, input.jobRun.jobRunId, 'sequence', flow.sequence)

  let jobRun = input.jobRun
  const sequenceResult = await advancePhase({
    deps: input.deps,
    job: input.job,
    jobRun,
    phase: 'sequence',
    steps: flow.sequence,
    actor,
    now,
  })
  jobRun = readJobRun(jobsStore, jobRun.jobRunId)

  if (sequenceResult.state === 'blocked') {
    return markJobRunRunning(jobsStore, jobRun, actor, now)
  }

  if (jobRun.status === 'failed' && jobRun.errorCode === 'agent_step_timeout') {
    skipRemainingSequenceSteps(jobsStore, jobRun.jobRunId, flow.sequence, now)
    return jobRun
  }

  if (sequenceResult.state === 'succeeded') {
    return jobsStore.updateJobRun(jobRun.jobRunId, {
      status: 'succeeded',
      completedAt: jobRun.completedAt ?? now,
      errorCode: null,
      errorMessage: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      actor,
    }).jobRun
  }

  skipRemainingSequenceSteps(jobsStore, jobRun.jobRunId, flow.sequence, now)

  if (flow.onFailure !== undefined && flow.onFailure.length > 0) {
    ensureStepRows(jobsStore, jobRun.jobRunId, 'onFailure', flow.onFailure)
    const onFailureResult = await advancePhase({
      deps: input.deps,
      job: input.job,
      jobRun,
      phase: 'onFailure',
      steps: flow.onFailure,
      actor,
      now,
    })
    jobRun = readJobRun(jobsStore, jobRun.jobRunId)

    if (onFailureResult.state === 'blocked') {
      return markJobRunRunning(jobsStore, jobRun, actor, now)
    }
  }

  const failedStep = findFirstFailedSequenceStep(jobsStore, jobRun.jobRunId, flow.sequence)
  const failure = describeFailedStep(failedStep)
  return jobsStore.updateJobRun(jobRun.jobRunId, {
    status: 'failed',
    completedAt: jobRun.completedAt ?? now,
    errorCode: failure.code,
    errorMessage: failure.message,
    leaseOwner: null,
    leaseExpiresAt: null,
    actor,
  }).jobRun
}

function ensureStepRows(
  jobsStore: JobsStore,
  jobRunId: string,
  phase: JobStepRunPhase,
  steps: readonly JobFlowStep[]
): void {
  const existing = jobsStore.jobStepRuns.listByJobRun(jobRunId).jobStepRuns
  const missing = steps.filter(
    (step) => !existing.some((row) => row.phase === phase && row.stepId === step.id)
  )
  if (missing.length === 0) {
    return
  }

  jobsStore.jobStepRuns.insertMany(
    jobRunId,
    phase,
    missing.map((step) => ({ stepId: step.id, attempt: 1, status: 'pending' }))
  )
}

async function advancePhase(input: {
  deps: ResolvedAcpServerDeps
  job: JobRecord
  jobRun: JobRunRecord
  phase: JobStepRunPhase
  steps: readonly JobFlowStep[]
  actor: Actor
  now: string
}): Promise<PhaseAdvanceResult> {
  const jobsStore = requireJobsStore(input.deps)
  const firstStep = input.steps[0]
  if (firstStep === undefined) {
    return { state: 'succeeded' }
  }

  const stepById = new Map(input.steps.map((step, index) => [step.id, { step, index }]))
  let currentStep: JobFlowStep | undefined = firstStep

  while (currentStep !== undefined) {
    const step = currentStep
    let stepRun = requireStepRun(jobsStore, input.jobRun.jobRunId, input.phase, step.id)

    if (!TERMINAL_STEP_STATUSES.has(stepRun.status)) {
      const advanced = await advanceStep({ ...input, step, stepRun })
      if (advanced.state === 'blocked') {
        return { state: 'blocked' }
      }

      stepRun = advanced.stepRun
    }

    const terminalTransition = resolveTerminalStepTransition(step, stepRun)
    stepRun = recordBranchTaken({
      jobsStore,
      jobRunId: input.jobRun.jobRunId,
      phase: input.phase,
      stepRun,
      branchTaken: terminalTransition.branchTaken,
    })
    const next = resolvePhaseTransition(input.steps, stepById, step, terminalTransition.transition)
    if (next.state !== 'advance') {
      return next
    }
    currentStep = next.step
  }

  return { state: 'succeeded' }
}

function advanceStep(input: StepAdvanceInput): Promise<StepAdvanceResult> {
  const { step } = input
  if (isExecStep(step)) {
    return advanceExecStep({ ...input, step })
  }
  if (isProbeStep(step)) {
    return advanceProbeStep({ ...input, step })
  }
  if (isNativeStep(step)) {
    return advanceNativeStep(input)
  }
  if (isAgentStep(step)) {
    return advanceAgentStep({ ...input, step })
  }
  throw new Error(`unsupported flow step kind: ${String(step.kind)}`)
}

function skipRemainingSequenceSteps(
  jobsStore: JobsStore,
  jobRunId: string,
  sequence: readonly JobFlowStep[],
  now: string
): void {
  for (const step of sequence) {
    const stepRun = currentStepRun(jobsStore, jobRunId, 'sequence', step.id)
    if (stepRun !== undefined && stepRun.status === 'pending') {
      jobsStore.jobStepRuns.updateStep(jobRunId, 'sequence', step.id, stepRun.attempt, {
        status: 'skipped',
        completedAt: stepRun.completedAt ?? now,
      })
    }
  }
}

function findFirstFailedSequenceStep(
  jobsStore: JobsStore,
  jobRunId: string,
  sequence: readonly JobFlowStep[]
): JobStepRunRecord | undefined {
  for (const step of sequence) {
    const stepRun = currentStepRun(jobsStore, jobRunId, 'sequence', step.id)
    if (stepRun !== undefined && stepRun.status !== 'succeeded' && stepRun.status !== 'skipped') {
      return stepRun
    }
  }

  return undefined
}

function markJobRunRunning(
  jobsStore: JobsStore,
  jobRun: JobRunRecord,
  actor: Actor,
  now: string
): JobRunRecord {
  if (
    jobRun.status === 'dispatched' &&
    jobRun.errorCode === undefined &&
    jobRun.errorMessage === undefined &&
    jobRun.leaseOwner === undefined &&
    jobRun.leaseExpiresAt === undefined
  ) {
    return jobRun
  }

  return jobsStore.updateJobRun(jobRun.jobRunId, {
    status: 'dispatched',
    dispatchedAt: jobRun.dispatchedAt ?? now,
    errorCode: null,
    errorMessage: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    actor,
  }).jobRun
}
