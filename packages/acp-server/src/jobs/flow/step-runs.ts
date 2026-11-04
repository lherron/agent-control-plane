import type { Actor, JobFlowStep, JobStepRunPhase, JobStepRunStatus } from 'acp-core'
import type {
  JobRecord,
  JobRunRecord,
  JobStepRunRecord,
  JobsStore,
  UpdateJobStepRunInput,
} from 'acp-jobs-store'

import type { ResolvedAcpServerDeps } from '../../deps.js'

// Job-run and step-run store access shared by the flow engine and its step
// advancers.

export type StepAdvanceInput<Step extends JobFlowStep = JobFlowStep> = {
  deps: ResolvedAcpServerDeps
  job: JobRecord
  jobRun: JobRunRecord
  phase: JobStepRunPhase
  step: Step
  stepRun: JobStepRunRecord
  actor: Actor
  now: string
}

export type StepAdvanceResult =
  | { state: 'terminal'; stepRun: JobStepRunRecord }
  | { state: 'blocked' }

export const TERMINAL_STEP_STATUSES = new Set<JobStepRunStatus>([
  'succeeded',
  'failed',
  'skipped',
  'cancelled',
])

export function requireJobsStore(deps: ResolvedAcpServerDeps): JobsStore {
  if (deps.jobsStore === undefined) {
    throw new Error('jobs store is not configured')
  }

  return deps.jobsStore
}

export function readJobRun(jobsStore: JobsStore, jobRunId: string): JobRunRecord {
  const jobRun = jobsStore.getJobRun(jobRunId).jobRun
  if (jobRun === undefined) {
    throw new Error(`job run not found: ${jobRunId}`)
  }
  return jobRun
}

/** The latest attempt of a step in a phase. */
export function currentStepRun(
  jobsStore: JobsStore,
  jobRunId: string,
  phase: JobStepRunPhase,
  stepId: string
): JobStepRunRecord | undefined {
  return jobsStore.jobStepRuns
    .listByJobRun(jobRunId)
    .jobStepRuns.filter((row) => row.phase === phase && row.stepId === stepId)
    .sort((left, right) => right.attempt - left.attempt)[0]
}

export function requireStepRun(
  jobsStore: JobsStore,
  jobRunId: string,
  phase: JobStepRunPhase,
  stepId: string
): JobStepRunRecord {
  const stepRun = currentStepRun(jobsStore, jobRunId, phase, stepId)
  if (stepRun === undefined) {
    throw new Error(`job step run not found: ${jobRunId}/${phase}/${stepId}`)
  }
  return stepRun
}

/** Writes a patch to the advancing step's given attempt. */
export function updateStepAttempt(
  input: StepAdvanceInput,
  attempt: number,
  patch: UpdateJobStepRunInput
): JobStepRunRecord {
  return requireJobsStore(input.deps).jobStepRuns.updateStep(
    input.jobRun.jobRunId,
    input.phase,
    input.step.id,
    attempt,
    patch
  ).jobStepRun
}

/** Marks an in-process (exec, probe, native) step running before it executes. */
export function markStepRunning(input: StepAdvanceInput): JobStepRunRecord {
  return updateStepAttempt(input, input.stepRun.attempt, {
    status: 'running',
    inputAttemptId: null,
    runId: null,
    startedAt: input.stepRun.startedAt ?? input.now,
    error: null,
  })
}

export function settleStep(
  input: StepAdvanceInput,
  attempt: number,
  patch: UpdateJobStepRunInput
): StepAdvanceResult {
  return { state: 'terminal', stepRun: updateStepAttempt(input, attempt, patch) }
}
