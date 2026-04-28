import type {
  Actor,
  JobFlowStep,
  JobStepRunPhase,
  JobStepRunStatus,
  Run,
  StepExpectation,
} from 'acp-core'
import {
  type JobRecord,
  type JobRunRecord,
  type JobStepRunRecord,
  validateJobFlow,
} from 'acp-jobs-store'
import { formatCanonicalSessionRef, resolveDatabasePath } from 'hrc-core'

import type { ResolvedAcpServerDeps } from '../deps.js'
import { dispatchStepThroughInputs } from './dispatch-step.js'
import {
  type RunOutcome,
  evaluateExpectation,
  mapRunStatusToOutcome,
  parseResultBlock,
} from './result-block.js'
import { getRunFinalAssistantText } from './run-final-output.js'

export type AdvanceJobFlowInput = {
  deps: ResolvedAcpServerDeps
  job: JobRecord
  jobRun: JobRunRecord
  now?: string | undefined
  actor?: Actor | undefined
}

type TerminalRunStatus = Extract<Run['status'], 'completed' | 'failed' | 'cancelled'>

const TERMINAL_STEP_STATUSES = new Set<JobStepRunStatus>([
  'succeeded',
  'failed',
  'skipped',
  'cancelled',
])

export async function advanceJobFlow(input: AdvanceJobFlowInput): Promise<JobRunRecord> {
  const flow = input.job.flow
  if (flow === undefined) {
    throw new Error(`job flow is required for ${input.job.jobId}`)
  }

  const validation = validateJobFlow(flow, { allowInputFile: false })
  if (!validation.valid) {
    throw new Error(`invalid job flow for ${input.job.jobId}`)
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

  if (sequenceResult.state === 'succeeded') {
    return jobsStore.updateJobRun(jobRun.jobRunId, {
      status: 'succeeded',
      completedAt: jobRun.completedAt ?? now,
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
  return jobsStore.updateJobRun(jobRun.jobRunId, {
    status: 'failed',
    completedAt: jobRun.completedAt ?? now,
    errorCode: failedStep?.error?.code ?? 'job_flow_sequence_failed',
    errorMessage: failedStep?.error?.message ?? 'job flow sequence failed',
    leaseOwner: null,
    leaseExpiresAt: null,
    actor,
  }).jobRun
}

function requireJobsStore(deps: ResolvedAcpServerDeps) {
  if (deps.jobsStore === undefined) {
    throw new Error('jobs store is not configured')
  }

  return deps.jobsStore
}

function readJobRun(
  jobsStore: NonNullable<ResolvedAcpServerDeps['jobsStore']>,
  jobRunId: string
): JobRunRecord {
  const jobRun = jobsStore.getJobRun(jobRunId).jobRun
  if (jobRun === undefined) {
    throw new Error(`job run not found: ${jobRunId}`)
  }
  return jobRun
}

function ensureStepRows(
  jobsStore: NonNullable<ResolvedAcpServerDeps['jobsStore']>,
  jobRunId: string,
  phase: JobStepRunPhase,
  steps: readonly JobFlowStep[]
): void {
  const missing = steps.filter(
    (step) => jobsStore.jobStepRuns.getById(jobRunId, phase, step.id, 1).jobStepRun === undefined
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

type PhaseAdvanceResult = { state: 'succeeded' } | { state: 'failed' } | { state: 'blocked' }

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

  for (const step of input.steps) {
    let stepRun = requireStepRun(jobsStore, input.jobRun.jobRunId, input.phase, step.id)
    if (TERMINAL_STEP_STATUSES.has(stepRun.status)) {
      if (stepRun.status === 'succeeded') {
        continue
      }
      return { state: 'failed' }
    }

    if (stepRun.runId === undefined) {
      const content = requireStepInput(step)
      await rotateFreshStepContext(input.deps, input.job, step)
      const dispatched = await dispatchStepThroughInputs(input.deps, {
        jobId: input.job.jobId,
        jobRunId: input.jobRun.jobRunId,
        phase: input.phase,
        stepId: step.id,
        attempt: stepRun.attempt,
        scopeRef: input.job.scopeRef,
        laneRef: input.job.laneRef,
        content,
        actor: input.actor,
      })

      stepRun = jobsStore.jobStepRuns.updateStep(
        input.jobRun.jobRunId,
        input.phase,
        step.id,
        stepRun.attempt,
        {
          status: 'running',
          inputAttemptId: dispatched.inputAttemptId,
          runId: dispatched.runId,
          startedAt: stepRun.startedAt ?? input.now,
        }
      ).jobStepRun
    }

    const terminal = getTerminalRunOutcome(input.deps, stepRun.runId)
    if (terminal === undefined) {
      return { state: 'blocked' }
    }

    stepRun = reconcileTerminalStepRun({
      deps: input.deps,
      jobRunId: input.jobRun.jobRunId,
      phase: input.phase,
      stepRun,
      step,
      runOutcome: terminal,
      now: input.now,
    })

    if (stepRun.status !== 'succeeded') {
      return { state: 'failed' }
    }
  }

  return { state: 'succeeded' }
}

function requireStepInput(step: JobFlowStep): string {
  const input = step.input?.trim()
  if (input === undefined || input.length === 0) {
    throw new Error(`flow step ${step.id} input must be a non-empty string`)
  }

  return input
}

async function rotateFreshStepContext(
  deps: ResolvedAcpServerDeps,
  job: JobRecord,
  step: JobFlowStep
): Promise<void> {
  if (step.fresh !== true || deps.hrcClient === undefined) {
    return
  }

  const session = await deps.hrcClient.resolveSession({
    sessionRef: formatCanonicalSessionRef({ scopeRef: job.scopeRef, laneRef: job.laneRef }),
  })

  await deps.hrcClient.clearContext({
    hostSessionId: session.hostSessionId,
    dropContinuation: true,
  })
}

function requireStepRun(
  jobsStore: NonNullable<ResolvedAcpServerDeps['jobsStore']>,
  jobRunId: string,
  phase: JobStepRunPhase,
  stepId: string
): JobStepRunRecord {
  const stepRun = jobsStore.jobStepRuns.getById(jobRunId, phase, stepId, 1).jobStepRun
  if (stepRun === undefined) {
    throw new Error(`job step run not found: ${jobRunId}/${phase}/${stepId}/1`)
  }
  return stepRun
}

function getTerminalRunOutcome(
  deps: ResolvedAcpServerDeps,
  runId: string | undefined
): RunOutcome | undefined {
  if (runId === undefined) {
    return undefined
  }

  const run = deps.runStore.getRun(runId)
  if (run === undefined) {
    return undefined
  }

  if (isTerminalRunStatus(run.status)) {
    return mapRunStatusToOutcome(run.status)
  }

  return undefined
}

function isTerminalRunStatus(status: Run['status']): status is TerminalRunStatus {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

function reconcileTerminalStepRun(input: {
  deps: ResolvedAcpServerDeps
  jobRunId: string
  phase: JobStepRunPhase
  stepRun: JobStepRunRecord
  step: JobFlowStep
  runOutcome: RunOutcome
  now: string
}): JobStepRunRecord {
  const expectation: StepExpectation = input.step.expect ?? {}
  const parsedResult =
    expectation.resultBlock === undefined
      ? undefined
      : parseResultBlock(
          readRunFinalAssistantText(input.deps, input.stepRun.runId),
          expectation.resultBlock
        )
  const evaluation = evaluateExpectation(input.runOutcome, parsedResult, expectation)
  const jobsStore = requireJobsStore(input.deps)

  return jobsStore.jobStepRuns.updateStep(
    input.jobRunId,
    input.phase,
    input.step.id,
    input.stepRun.attempt,
    {
      status: evaluation.ok ? 'succeeded' : 'failed',
      ...(expectation.resultBlock !== undefined ? { resultBlock: expectation.resultBlock } : {}),
      ...(evaluation.result !== undefined ? { result: evaluation.result } : {}),
      ...(evaluation.error !== undefined ? { error: evaluation.error } : { error: null }),
      completedAt: input.stepRun.completedAt ?? input.now,
    }
  ).jobStepRun
}

function readRunFinalAssistantText(deps: ResolvedAcpServerDeps, runId: string | undefined): string {
  if (runId === undefined) {
    return ''
  }

  return (
    getRunFinalAssistantText(
      {
        getRun: (id) => deps.runStore.getRun(id),
        hrcDbPath: resolveHrcDbPath(deps),
      },
      runId
    ) ?? ''
  )
}

function resolveHrcDbPath(deps: ResolvedAcpServerDeps): string {
  const configured = (deps as ResolvedAcpServerDeps & { hrcDbPath?: string }).hrcDbPath
  return configured ?? resolveDatabasePath()
}

function skipRemainingSequenceSteps(
  jobsStore: NonNullable<ResolvedAcpServerDeps['jobsStore']>,
  jobRunId: string,
  sequence: readonly JobFlowStep[],
  now: string
): void {
  for (const step of sequence) {
    const stepRun = jobsStore.jobStepRuns.getById(jobRunId, 'sequence', step.id, 1).jobStepRun
    if (stepRun !== undefined && stepRun.status === 'pending') {
      jobsStore.jobStepRuns.updateStep(jobRunId, 'sequence', step.id, 1, {
        status: 'skipped',
        completedAt: stepRun.completedAt ?? now,
      })
    }
  }
}

function findFirstFailedSequenceStep(
  jobsStore: NonNullable<ResolvedAcpServerDeps['jobsStore']>,
  jobRunId: string,
  sequence: readonly JobFlowStep[]
): JobStepRunRecord | undefined {
  for (const step of sequence) {
    const stepRun = jobsStore.jobStepRuns.getById(jobRunId, 'sequence', step.id, 1).jobStepRun
    if (stepRun !== undefined && stepRun.status !== 'succeeded' && stepRun.status !== 'skipped') {
      return stepRun
    }
  }

  return undefined
}

function markJobRunRunning(
  jobsStore: NonNullable<ResolvedAcpServerDeps['jobsStore']>,
  jobRun: JobRunRecord,
  actor: Actor,
  now: string
): JobRunRecord {
  if (jobRun.status === 'dispatched') {
    return jobRun
  }

  return jobsStore.updateJobRun(jobRun.jobRunId, {
    status: 'dispatched',
    dispatchedAt: jobRun.dispatchedAt ?? now,
    leaseOwner: null,
    leaseExpiresAt: null,
    actor,
  }).jobRun
}
