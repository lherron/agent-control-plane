import type {
  Actor,
  BranchTaken,
  ExecFlowStep,
  ExecStepResult,
  FlowNext,
  JobFlowStep,
  JobStepRunPhase,
  JobStepRunStatus,
  ProbeFlowStep,
  ProbeOutcome,
  ProbeStepResult,
  Run,
  StepExpectation,
} from 'acp-core'
import {
  type JobRecord,
  type JobRunRecord,
  type JobStepRunRecord,
  type NativeStepExecutorDeps,
  executeNativeSideEffectStep,
  formatJobFlowValidationErrors,
  parseFreshDurationMs,
  validateJobFlowJob,
} from 'acp-jobs-store'
import type { LaneRef } from 'agent-scope'
import { formatCanonicalSessionRef, resolveDatabasePath } from 'hrc-core'
import { createOrFindWrkqTask } from 'wrkq-lib'

import type { ResolvedAcpServerDeps } from '../deps.js'
import { handleCreateAgentPulpitMessage } from '../handlers/agent-pulpit-messages.js'
import { handleCreateInput } from '../handlers/inputs.js'
import { dispatchStepThroughInputs } from './dispatch-step.js'
import { resolveJobExecPolicy } from './exec-policy.js'
import { ExecStepError, runExecStep } from './exec-step.js'
import {
  type RunOutcome,
  evaluateExpectation,
  mapRunStatusToOutcome,
  parseResultBlock,
} from './result-block.js'
import { getRunFinalAssistantText } from './run-final-output.js'

type AgentRunnableStep = Extract<JobFlowStep, { kind?: 'agent' | undefined }>
type ProbeRunnableStep = Extract<JobFlowStep, { kind: 'probe' }>

export type AdvanceJobFlowInput = {
  deps: ResolvedAcpServerDeps
  job: JobRecord
  jobRun: JobRunRecord
  now?: string | undefined
  actor?: Actor | undefined
}

type TerminalRunStatus = Extract<Run['status'], 'completed' | 'failed' | 'cancelled'>
type DispatchedStepRun = JobStepRunRecord & { runId: string }

type ScheduledFreshMetadata = {
  jobId: string
  phase: JobStepRunPhase
  stepId: string
  freshDuration: string
  windowStartedAt: string
}

type ScheduledFreshCleanupDegradation = Readonly<{
  code: 'scheduled_fresh_pre_run_cleanup_degraded'
  previousRuntimeId: string
  failureCode: string
  message: string
}>

type FreshStepDispatchPlan =
  | {
      ok: true
      rotateContext: boolean
      cleanupPrevious: boolean
      previous?: DispatchedStepRun | undefined
      scheduledFresh?: ScheduledFreshMetadata | undefined
    }
  | { ok: false; message: string }

const SCHEDULED_FRESH_METADATA_KEY = 'scheduledFresh'
const SCHEDULED_FRESH_PRE_RUN_CLEANUP_DEGRADED = 'scheduled_fresh_pre_run_cleanup_degraded'
const AGENT_STEP_TERMINATE_TIMEOUT_MS = 50
const PROBE_REGISTRY: Record<string, ProbeRunner> = {
  'hrc-stale-tty-reap.v1': runHrcClientProbe,
}

const TERMINAL_STEP_STATUSES = new Set<JobStepRunStatus>([
  'succeeded',
  'failed',
  'skipped',
  'cancelled',
])
const TERMINAL_JOB_RUN_STATUSES = new Set<JobRunRecord['status']>([
  'succeeded',
  'failed',
  'skipped',
])

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

type PhaseAdvanceResult = { state: 'succeeded' } | { state: 'failed' } | { state: 'blocked' }

type ProbeRunner = (input: {
  deps: ResolvedAcpServerDeps
  job: JobRecord
  jobRun: JobRunRecord
  phase: JobStepRunPhase
  step: ProbeRunnableStep
}) => Promise<{ outcome: ProbeOutcome }>

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
      const advanced = isExecStep(step)
        ? await advanceExecStep({ ...input, step, stepRun })
        : isProbeStep(step)
          ? await advanceProbeStep({ ...input, step, stepRun })
          : isNativeStep(step)
            ? await advanceNativeStep({ ...input, step, stepRun })
            : isAgentStep(step)
              ? await advanceAgentStep({ ...input, step, stepRun })
              : failUnknownStepKind(step)

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

type StepAdvanceResult = { state: 'terminal'; stepRun: JobStepRunRecord } | { state: 'blocked' }

async function advanceProbeStep(input: {
  deps: ResolvedAcpServerDeps
  job: JobRecord
  jobRun: JobRunRecord
  phase: JobStepRunPhase
  step: ProbeFlowStep
  stepRun: JobStepRunRecord
  now: string
}): Promise<StepAdvanceResult> {
  const jobsStore = requireJobsStore(input.deps)
  const startedStepRun = jobsStore.jobStepRuns.updateStep(
    input.jobRun.jobRunId,
    input.phase,
    input.step.id,
    input.stepRun.attempt,
    {
      status: 'running',
      inputAttemptId: null,
      runId: null,
      startedAt: input.stepRun.startedAt ?? input.now,
      error: null,
    }
  ).jobStepRun

  try {
    const runner = PROBE_REGISTRY[input.step.probe.name]
    if (runner === undefined) {
      throw new ProbeStepError('unknown_probe_name', `unknown probe name: ${input.step.probe.name}`)
    }

    const { outcome } = await runner(input)
    const result = {
      kind: 'probe',
      name: input.step.probe.name,
      outcome,
    } satisfies ProbeStepResult
    return {
      state: 'terminal',
      stepRun: jobsStore.jobStepRuns.updateStep(
        input.jobRun.jobRunId,
        input.phase,
        input.step.id,
        startedStepRun.attempt,
        {
          status: 'succeeded',
          result,
          completedAt: input.now,
        }
      ).jobStepRun,
    }
  } catch (error) {
    const code = error instanceof ProbeStepError ? error.code : 'probe_failed'
    const message = error instanceof Error ? error.message : 'probe step failed'
    return {
      state: 'terminal',
      stepRun: jobsStore.jobStepRuns.updateStep(
        input.jobRun.jobRunId,
        input.phase,
        input.step.id,
        startedStepRun.attempt,
        {
          status: 'failed',
          error: { code, message },
          completedAt: input.now,
        }
      ).jobStepRun,
    }
  }
}

class ProbeStepError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

async function runHrcClientProbe(input: {
  deps: ResolvedAcpServerDeps
  job: JobRecord
  jobRun: JobRunRecord
  phase: JobStepRunPhase
  step: ProbeRunnableStep
}): Promise<{ outcome: ProbeOutcome }> {
  const probe = input.deps.hrcClient?.probe
  if (input.deps.hrcClient === undefined) {
    throw new ProbeStepError('probe_unavailable', 'hrcClient probe capability is not configured')
  }

  if (probe === undefined) {
    const staleRuntimes = await input.deps.hrcClient.listRuntimes({ stale: true })
    const hasStaleTtyRuntime = staleRuntimes.some(
      (runtime) => runtime.transport === 'tmux' || runtime.transport === 'ghostty'
    )
    return { outcome: hasStaleTtyRuntime ? 'work' : 'idle' }
  }

  const result = await probe({
    name: input.step.probe.name,
    jobId: input.job.jobId,
    jobRunId: input.jobRun.jobRunId,
    phase: input.phase,
    stepId: input.step.id,
    scopeRef: input.job.scopeRef,
    laneRef: input.job.laneRef,
  })
  if (result.outcome !== 'idle' && result.outcome !== 'work') {
    throw new ProbeStepError(
      'invalid_probe_outcome',
      `probe ${input.step.probe.name} returned invalid outcome: ${String(result.outcome)}`
    )
  }
  return result
}

async function advanceNativeStep(input: {
  deps: ResolvedAcpServerDeps
  job: JobRecord
  jobRun: JobRunRecord
  phase: JobStepRunPhase
  step: JobFlowStep
  stepRun: JobStepRunRecord
  actor: Actor
  now: string
}): Promise<StepAdvanceResult> {
  const jobsStore = requireJobsStore(input.deps)
  const startedStepRun = jobsStore.jobStepRuns.updateStep(
    input.jobRun.jobRunId,
    input.phase,
    input.step.id,
    input.stepRun.attempt,
    {
      status: 'running',
      inputAttemptId: null,
      runId: null,
      startedAt: input.stepRun.startedAt ?? input.now,
      error: null,
    }
  ).jobStepRun

  try {
    const { stepDef, resolvedFields } = resolveNativeStepDef({
      jobsStore,
      jobRun: input.jobRun,
      phase: input.phase,
      step: input.step,
    })
    await executeNativeSideEffectStep(resolveNativeStepExecutorDeps(input.deps, jobsStore), {
      jobRunId: input.jobRun.jobRunId,
      phase: input.phase,
      stepId: input.step.id,
      attempt: startedStepRun.attempt,
      stepKind: input.step.kind as 'wrkq-task' | 'pulpit-message' | 'agent-dispatch',
      stepDef,
      resolvedFields,
    })

    return {
      state: 'terminal',
      stepRun: jobsStore.jobStepRuns.updateStep(
        input.jobRun.jobRunId,
        input.phase,
        input.step.id,
        startedStepRun.attempt,
        { completedAt: input.now }
      ).jobStepRun,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      state: 'terminal',
      stepRun: jobsStore.jobStepRuns.updateStep(
        input.jobRun.jobRunId,
        input.phase,
        input.step.id,
        startedStepRun.attempt,
        {
          status: 'failed',
          error: { code: 'native_step_failed', message },
          completedAt: input.now,
        }
      ).jobStepRun,
    }
  }
}

async function advanceAgentStep(input: {
  deps: ResolvedAcpServerDeps
  job: JobRecord
  jobRun: JobRunRecord
  phase: JobStepRunPhase
  step: AgentRunnableStep
  stepRun: JobStepRunRecord
  actor: Actor
  now: string
}): Promise<StepAdvanceResult> {
  const jobsStore = requireJobsStore(input.deps)
  let stepRun = input.stepRun

  if (stepRun.runId === undefined) {
    const dispatchStartedAt = stepRun.startedAt ?? input.now
    const freshPlan = resolveFreshStepDispatchPlan({
      ...input,
      dispatchStartedAt,
    })
    if (!freshPlan.ok) {
      return {
        state: 'terminal',
        stepRun: jobsStore.jobStepRuns.updateStep(
          input.jobRun.jobRunId,
          input.phase,
          input.step.id,
          stepRun.attempt,
          {
            status: 'failed',
            inputAttemptId: null,
            runId: null,
            startedAt: dispatchStartedAt,
            error: { code: 'pre_run_cleanup_failed', message: freshPlan.message },
            completedAt: input.now,
          }
        ).jobStepRun,
      }
    }

    const cleanup = await cleanupPreviousScheduledFreshStepRuntime(input, freshPlan)
    if (!cleanup.ok) {
      return {
        state: 'terminal',
        stepRun: jobsStore.jobStepRuns.updateStep(
          input.jobRun.jobRunId,
          input.phase,
          input.step.id,
          stepRun.attempt,
          {
            status: 'failed',
            inputAttemptId: null,
            runId: null,
            startedAt: dispatchStartedAt,
            error: { code: 'pre_run_cleanup_failed', message: cleanup.message },
            completedAt: input.now,
          }
        ).jobStepRun,
      }
    }
    const degradationResult =
      cleanup.degradation === undefined
        ? {}
        : { result: { ...(stepRun.result ?? {}), degradation: cleanup.degradation } }

    try {
      const content = requireStepInput(input.step)
      await rotateFreshStepContext(input.deps, input.job, input.step, freshPlan.rotateContext)
      const dispatched = await dispatchStepThroughInputs(input.deps, {
        jobId: input.job.jobId,
        jobRunId: input.jobRun.jobRunId,
        phase: input.phase,
        stepId: input.step.id,
        attempt: stepRun.attempt,
        scopeRef: input.job.scopeRef,
        laneRef: input.job.laneRef,
        content,
        actor: input.actor,
      })
      if (freshPlan.scheduledFresh !== undefined) {
        stampScheduledFreshMetadata(input.deps, dispatched.runId, freshPlan.scheduledFresh)
      }

      stepRun = jobsStore.jobStepRuns.updateStep(
        input.jobRun.jobRunId,
        input.phase,
        input.step.id,
        stepRun.attempt,
        {
          status: 'running',
          inputAttemptId: dispatched.inputAttemptId,
          runId: dispatched.runId,
          startedAt: dispatchStartedAt,
          ...degradationResult,
        }
      ).jobStepRun
    } catch (error) {
      if (!isTransientFlowAdvanceError(error)) {
        throw error
      }
      failStepDispatchAttemptAndQueueRetry({
        jobsStore,
        jobRunId: input.jobRun.jobRunId,
        phase: input.phase,
        stepId: input.step.id,
        attempt: stepRun.attempt,
        startedAt: dispatchStartedAt,
        completedAt: input.now,
        error,
      })
      throw error
    }
  }

  const terminal = getTerminalRunOutcome(input.deps, stepRun.runId)
  if (terminal === undefined && hasAgentStepTimedOut(stepRun, input.step, input.now)) {
    return {
      state: 'terminal',
      stepRun: failTimedOutAgentStep(input, stepRun),
    }
  }

  if (terminal === undefined) {
    return { state: 'blocked' }
  }

  return {
    state: 'terminal',
    stepRun: reconcileTerminalStepRun({
      deps: input.deps,
      jobRunId: input.jobRun.jobRunId,
      phase: input.phase,
      stepRun,
      step: input.step,
      runOutcome: terminal,
      now: input.now,
    }),
  }
}

type FreshStepCleanupResult =
  | { ok: true; degradation?: ScheduledFreshCleanupDegradation | undefined }
  | { ok: false; message: string }

function resolveFreshStepDispatchPlan(input: {
  deps: ResolvedAcpServerDeps
  job: JobRecord
  jobRun: JobRunRecord
  phase: JobStepRunPhase
  step: AgentRunnableStep
  dispatchStartedAt: string
}): FreshStepDispatchPlan {
  if (input.step.fresh !== true) {
    return { ok: true, rotateContext: false, cleanupPrevious: false }
  }

  if (!isScheduledFreshStepDispatch(input.job, input.jobRun)) {
    return { ok: true, rotateContext: true, cleanupPrevious: false }
  }

  const jobsStore = requireJobsStore(input.deps)
  const previous = findPreviousDispatchedStepRun({
    jobsStore,
    jobId: input.job.jobId,
    currentJobRunId: input.jobRun.jobRunId,
    phase: input.phase,
    stepId: input.step.id,
  })
  if (previous !== undefined && !isPreviousFreshStepEffectivelyTerminal(jobsStore, previous)) {
    return {
      ok: false,
      message: `previous fresh step ${previous.jobRunId}/${input.phase}/${input.step.id} is still ${previous.status}`,
    }
  }

  if (input.step.freshDuration === undefined) {
    return { ok: true, rotateContext: true, cleanupPrevious: true, previous }
  }

  const freshDurationMs = parseFreshDurationMs(input.step.freshDuration)
  if (freshDurationMs === undefined) {
    return {
      ok: false,
      message: `invalid freshDuration for ${input.job.jobId}/${input.phase}/${input.step.id}`,
    }
  }

  const rotationMetadata = buildScheduledFreshMetadata(input, input.dispatchStartedAt)
  if (previous === undefined) {
    return {
      ok: true,
      rotateContext: true,
      cleanupPrevious: false,
      scheduledFresh: rotationMetadata,
    }
  }

  const priorRun = input.deps.runStore.getRun(previous.runId)
  const priorMetadata =
    priorRun === undefined
      ? undefined
      : readScheduledFreshMetadata(priorRun.metadata?.[SCHEDULED_FRESH_METADATA_KEY], input)
  const windowStartedAt =
    priorMetadata === undefined ? Number.NaN : Date.parse(priorMetadata.windowStartedAt)
  const dispatchStartedAt = Date.parse(input.dispatchStartedAt)
  if (
    priorMetadata !== undefined &&
    Number.isFinite(windowStartedAt) &&
    Number.isFinite(dispatchStartedAt) &&
    dispatchStartedAt >= windowStartedAt &&
    dispatchStartedAt - windowStartedAt < freshDurationMs
  ) {
    return {
      ok: true,
      rotateContext: false,
      cleanupPrevious: false,
      previous,
      scheduledFresh: priorMetadata,
    }
  }

  return {
    ok: true,
    rotateContext: true,
    cleanupPrevious: true,
    previous,
    scheduledFresh: rotationMetadata,
  }
}

async function cleanupPreviousScheduledFreshStepRuntime(
  input: {
    deps: ResolvedAcpServerDeps
    job: JobRecord
    jobRun: JobRunRecord
    phase: JobStepRunPhase
    step: AgentRunnableStep
    stepRun: JobStepRunRecord
    actor: Actor
  },
  plan: Extract<FreshStepDispatchPlan, { ok: true }>
): Promise<FreshStepCleanupResult> {
  if (!plan.cleanupPrevious) {
    return { ok: true }
  }

  const previous = plan.previous
  if (previous === undefined) {
    return { ok: true }
  }

  if (!isPreviousFreshStepEffectivelyTerminal(requireJobsStore(input.deps), previous)) {
    return {
      ok: false,
      message: `previous fresh step ${previous.jobRunId}/${input.phase}/${input.step.id} is still ${previous.status}`,
    }
  }

  const priorRun = input.deps.runStore.getRun(previous.runId)
  if (priorRun === undefined) {
    return {
      ok: false,
      message: `previous fresh step run ${previous.runId} has no ACP run record`,
    }
  }
  if (priorRun.runtimeId === undefined) {
    return {
      ok: false,
      message: `previous fresh step run ${previous.runId} has no runtimeId`,
    }
  }
  if (input.deps.hrcClient === undefined) {
    return {
      ok: false,
      message: `previous fresh step runtime ${priorRun.runtimeId} cannot be cleaned without HRC client`,
    }
  }

  try {
    await input.deps.hrcClient.terminate(priorRun.runtimeId, {
      dropContinuation: false,
      reason: 'scheduled_fresh_pre_run_cleanup',
      source: 'acp-scheduled-job-runner',
      actor: actorToAuditString(input.actor),
    })
    terminalizeCleanedPreviousRunIfNeeded(input, previous, priorRun.runId)
    return { ok: true }
  } catch (error) {
    if (isBenignTerminateError(error)) {
      return { ok: true }
    }
    if (isDegradableScheduledFreshCleanupError(error)) {
      const degradation = {
        code: SCHEDULED_FRESH_PRE_RUN_CLEANUP_DEGRADED,
        previousRuntimeId: priorRun.runtimeId,
        failureCode: cleanupFailureCode(error),
        message: `failed to clean previous fresh step runtime ${priorRun.runtimeId}: ${errorMessage(error)}`,
      } satisfies ScheduledFreshCleanupDegradation
      emitScheduledFreshCleanupDegraded(input, degradation)
      return { ok: true, degradation }
    }
    return {
      ok: false,
      message: `failed to clean previous fresh step runtime ${priorRun.runtimeId}: ${errorMessage(error)}`,
    }
  }
}

function isPreviousFreshStepEffectivelyTerminal(
  jobsStore: NonNullable<ResolvedAcpServerDeps['jobsStore']>,
  previous: DispatchedStepRun
): boolean {
  if (TERMINAL_STEP_STATUSES.has(previous.status)) {
    return true
  }

  const jobRun = jobsStore.getJobRun(previous.jobRunId).jobRun
  return jobRun !== undefined && isTerminalJobRunStatus(jobRun.status)
}

function isTerminalJobRunStatus(status: JobRunRecord['status']): boolean {
  return TERMINAL_JOB_RUN_STATUSES.has(status)
}

function terminalizeCleanedPreviousRunIfNeeded(
  input: {
    deps: ResolvedAcpServerDeps
  },
  previous: DispatchedStepRun,
  priorRunId: string
): void {
  const jobsStore = requireJobsStore(input.deps)
  const previousJobRun = jobsStore.getJobRun(previous.jobRunId).jobRun
  const priorRun = input.deps.runStore.getRun(priorRunId)
  if (
    previousJobRun === undefined ||
    priorRun === undefined ||
    !isTerminalJobRunStatus(previousJobRun.status) ||
    isTerminalRunStatus(priorRun.status)
  ) {
    return
  }

  input.deps.runStore.updateRun(priorRun.runId, {
    status: 'cancelled',
    errorCode: 'scheduled_fresh_pre_run_cleanup',
    errorMessage: 'terminated stale scheduled fresh runtime before rotation',
  })
}

function emitScheduledFreshCleanupDegraded(
  input: {
    deps: ResolvedAcpServerDeps
    job: JobRecord
    jobRun: JobRunRecord
    phase: JobStepRunPhase
    step: AgentRunnableStep
  },
  degradation: ScheduledFreshCleanupDegradation
): void {
  const jobsStore = requireJobsStore(input.deps)
  const occurredAt = input.jobRun.triggeredAt
  const eventSeq = Date.parse(occurredAt)
  jobsStore.insertInboxEvent({
    eventId: `${SCHEDULED_FRESH_PRE_RUN_CLEANUP_DEGRADED}:${input.jobRun.jobRunId}:${input.phase}:${input.step.id}:${degradation.previousRuntimeId}`,
    eventSeq: Number.isFinite(eventSeq) ? eventSeq : Date.now(),
    source: 'acp-health',
    event: SCHEDULED_FRESH_PRE_RUN_CLEANUP_DEGRADED,
    occurredAt,
    receivedAt: occurredAt,
    payload: {
      event: SCHEDULED_FRESH_PRE_RUN_CLEANUP_DEGRADED,
      payload: {
        jobId: input.job.jobId,
        jobRunId: input.jobRun.jobRunId,
        phase: input.phase,
        stepId: input.step.id,
        previousRuntimeId: degradation.previousRuntimeId,
        failureCode: degradation.failureCode,
        message: degradation.message,
      },
    },
  })
}

function isScheduledFreshStepDispatch(job: JobRecord, jobRun: JobRunRecord): boolean {
  return job.trigger.kind === 'schedule' && isScheduledJobRunTrigger(jobRun.triggeredBy)
}

function isScheduledJobRunTrigger(trigger: JobRunRecord['triggeredBy']): boolean {
  return trigger === 'schedule' || trigger === 'catch-up'
}

function buildScheduledFreshMetadata(
  input: {
    job: JobRecord
    phase: JobStepRunPhase
    step: AgentRunnableStep
  },
  windowStartedAt: string
): ScheduledFreshMetadata {
  return {
    jobId: input.job.jobId,
    phase: input.phase,
    stepId: input.step.id,
    freshDuration: input.step.freshDuration ?? '',
    windowStartedAt,
  }
}

function readScheduledFreshMetadata(
  value: unknown,
  input: {
    job: JobRecord
    phase: JobStepRunPhase
    step: AgentRunnableStep
  }
): ScheduledFreshMetadata | undefined {
  if (!isRecord(value)) {
    return undefined
  }

  const metadata = value as Record<string, unknown>
  if (
    metadata['jobId'] !== input.job.jobId ||
    metadata['phase'] !== input.phase ||
    metadata['stepId'] !== input.step.id ||
    metadata['freshDuration'] !== input.step.freshDuration ||
    typeof metadata['windowStartedAt'] !== 'string'
  ) {
    return undefined
  }

  return {
    jobId: metadata['jobId'],
    phase: metadata['phase'],
    stepId: metadata['stepId'],
    freshDuration: metadata['freshDuration'],
    windowStartedAt: metadata['windowStartedAt'],
  } as ScheduledFreshMetadata
}

function stampScheduledFreshMetadata(
  deps: ResolvedAcpServerDeps,
  runId: string,
  scheduledFresh: ScheduledFreshMetadata
): void {
  const run = deps.runStore.getRun(runId)
  if (run === undefined) {
    throw new Error(`freshDuration dispatch run not found: ${runId}`)
  }

  deps.runStore.updateRun(runId, {
    metadata: {
      ...(run.metadata ?? {}),
      [SCHEDULED_FRESH_METADATA_KEY]: scheduledFresh,
    },
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function currentStepRun(
  jobsStore: NonNullable<ResolvedAcpServerDeps['jobsStore']>,
  jobRunId: string,
  phase: JobStepRunPhase,
  stepId: string
): JobStepRunRecord | undefined {
  return jobsStore.jobStepRuns
    .listByJobRun(jobRunId)
    .jobStepRuns.filter((row) => row.phase === phase && row.stepId === stepId)
    .sort((left, right) => right.attempt - left.attempt)[0]
}

function findPreviousDispatchedStepRun(input: {
  jobsStore: NonNullable<ResolvedAcpServerDeps['jobsStore']>
  jobId: string
  currentJobRunId: string
  phase: JobStepRunPhase
  stepId: string
}): DispatchedStepRun | undefined {
  for (const jobRun of input.jobsStore.listJobRuns(input.jobId).jobRuns) {
    if (jobRun.jobRunId === input.currentJobRunId) {
      continue
    }

    const stepRun = currentStepRun(input.jobsStore, jobRun.jobRunId, input.phase, input.stepId)
    if (stepRun?.runId === undefined) {
      continue
    }
    if (hasScheduledFreshCleanupDegradation(stepRun)) {
      continue
    }

    return stepRun as JobStepRunRecord & { runId: string }
  }

  return undefined
}

function hasScheduledFreshCleanupDegradation(stepRun: JobStepRunRecord): boolean {
  const directDegradation = (stepRun as unknown as { degradation?: unknown }).degradation
  const degradation = isRecord(directDegradation)
    ? directDegradation
    : isRecord(stepRun.result?.['degradation'])
      ? stepRun.result['degradation']
      : undefined
  return degradation?.['code'] === SCHEDULED_FRESH_PRE_RUN_CLEANUP_DEGRADED
}

function isBenignTerminateError(error: unknown): boolean {
  const code = errorCode(error)
  if (
    code === 'unknown_runtime' ||
    code === 'unknown_host_session' ||
    code === 'unknown_session' ||
    // The runtime is already terminated/dead/stale — pre-run cleanup only wants
    // it gone, so an unavailable runtime means cleanup already succeeded.
    code === 'runtime_unavailable'
  ) {
    return true
  }

  const message = errorMessage(error).toLowerCase()
  return (
    message.includes('not found') ||
    message.includes('unknown runtime') ||
    message.includes('already terminated') ||
    message.includes('is terminated') ||
    message.includes('is dead') ||
    message.includes('is stale')
  )
}

function isDegradableScheduledFreshCleanupError(error: unknown): boolean {
  const code = errorCode(error)
  if (code === 'terminate_timeout' || code === 'http_500') {
    return true
  }

  const status = errorStatus(error)
  if (status === 500) {
    return true
  }

  return errorMessage(error).toLowerCase().includes('timed out')
}

function cleanupFailureCode(error: unknown): string {
  const code = errorCode(error)
  if (code !== undefined) {
    return code
  }

  const status = errorStatus(error)
  return status === undefined ? 'scheduled_fresh_pre_run_cleanup_failed' : `http_${status}`
}

function failStepDispatchAttemptAndQueueRetry(input: {
  jobsStore: NonNullable<ResolvedAcpServerDeps['jobsStore']>
  jobRunId: string
  phase: JobStepRunPhase
  stepId: string
  attempt: number
  startedAt: string
  completedAt: string
  error: unknown
}): void {
  input.jobsStore.jobStepRuns.updateStep(input.jobRunId, input.phase, input.stepId, input.attempt, {
    status: 'failed',
    inputAttemptId: null,
    runId: null,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    error: { code: 'step_dispatch_transient', message: errorMessage(input.error) },
  })

  const nextAttempt = input.attempt + 1
  if (
    input.jobsStore.jobStepRuns.getById(input.jobRunId, input.phase, input.stepId, nextAttempt)
      .jobStepRun === undefined
  ) {
    input.jobsStore.jobStepRuns.insertMany(input.jobRunId, input.phase, [
      { stepId: input.stepId, attempt: nextAttempt, status: 'pending' },
    ])
  }
}

function isTransientFlowAdvanceError(error: unknown): boolean {
  const code = errorCode(error)
  if (
    code === 'ETIMEDOUT' ||
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'EHOSTUNREACH' ||
    code === 'ENETUNREACH' ||
    code === 'hrc_unavailable' ||
    code === 'dispatch_failed'
  ) {
    return true
  }

  const status = errorStatus(error)
  if (status !== undefined && status >= 500 && status <= 599) {
    return true
  }

  const message = errorMessage(error).toLowerCase()
  return (
    message.includes('timed out') ||
    message.includes('timeout') ||
    message.includes('hrc unavailable') ||
    message.includes('dispatch gateway returned http 5') ||
    message.includes('http 503') ||
    message.includes('http 502') ||
    message.includes('http 500') ||
    message.includes('hostsessionid is required') ||
    message.includes('runtime already has an active run') ||
    message.includes('different request body already exists for idempotencykey')
  )
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined
}

function errorStatus(error: unknown): number | undefined {
  return typeof error === 'object' &&
    error !== null &&
    typeof (error as { status?: unknown }).status === 'number'
    ? (error as { status: number }).status
    : undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function actorToAuditString(actor: Actor): string {
  return actor.displayName !== undefined
    ? `${actor.kind}:${actor.id} (${actor.displayName})`
    : `${actor.kind}:${actor.id}`
}

async function advanceExecStep(input: {
  deps: ResolvedAcpServerDeps
  job: JobRecord
  jobRun: JobRunRecord
  phase: JobStepRunPhase
  step: ExecFlowStep
  stepRun: JobStepRunRecord
  now: string
}): Promise<StepAdvanceResult> {
  const jobsStore = requireJobsStore(input.deps)
  const startedStepRun = jobsStore.jobStepRuns.updateStep(
    input.jobRun.jobRunId,
    input.phase,
    input.step.id,
    input.stepRun.attempt,
    {
      status: 'running',
      inputAttemptId: null,
      runId: null,
      startedAt: input.stepRun.startedAt ?? input.now,
      error: null,
    }
  ).jobStepRun

  try {
    const result = await runExecStep({
      step: input.step,
      defaultCwd: await resolveExecDefaultCwd(input.deps, input.job),
      policy: input.deps.jobExecPolicy ?? resolveJobExecPolicy(),
    })
    const status = isSuccessfulExecStepResult(input.step, result) ? 'succeeded' : 'failed'

    return {
      state: 'terminal',
      stepRun: jobsStore.jobStepRuns.updateStep(
        input.jobRun.jobRunId,
        input.phase,
        input.step.id,
        startedStepRun.attempt,
        {
          status,
          result: result as unknown as Readonly<Record<string, unknown>>,
          error: result.timedOut ? { code: 'exec_timeout', message: 'exec step timed out' } : null,
          completedAt: result.completedAt,
        }
      ).jobStepRun,
    }
  } catch (error) {
    const code = error instanceof ExecStepError ? error.code : 'exec_spawn_failed'
    const message = error instanceof Error ? error.message : 'exec step failed'

    return {
      state: 'terminal',
      stepRun: jobsStore.jobStepRuns.updateStep(
        input.jobRun.jobRunId,
        input.phase,
        input.step.id,
        startedStepRun.attempt,
        {
          status: 'failed',
          error: { code, message },
          completedAt: input.now,
        }
      ).jobStepRun,
    }
  }
}

type PhaseTransition = FlowNext | 'continue'
type TerminalStepTransition = {
  transition: PhaseTransition
  branchTaken?: BranchTaken | undefined
}

type ResolvedPhaseTransition =
  | { state: 'advance'; step: JobFlowStep | undefined }
  | { state: 'succeeded' }
  | { state: 'failed' }

function resolveTerminalStepTransition(
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

function recordBranchTaken(input: {
  jobsStore: NonNullable<ResolvedAcpServerDeps['jobsStore']>
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

function resolvePhaseTransition(
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

function isExecStep(step: JobFlowStep): step is ExecFlowStep {
  return step.kind === 'exec'
}

function isProbeStep(step: JobFlowStep): step is ProbeFlowStep {
  return step.kind === 'probe'
}

function isSuccessfulExecStepResult(step: ExecFlowStep, result: ExecStepResult): boolean {
  if (result.timedOut || result.exitCode === null) {
    return false
  }
  const successExitCodes = step.exec.successExitCodes ?? [0]
  return successExitCodes.includes(result.exitCode)
}

function isNativeStep(step: JobFlowStep): boolean {
  return (
    step.kind === 'wrkq-task' || step.kind === 'pulpit-message' || step.kind === 'agent-dispatch'
  )
}

function isAgentStep(step: JobFlowStep): step is AgentRunnableStep {
  return step.kind === undefined || step.kind === 'agent'
}

function failUnknownStepKind(step: JobFlowStep): never {
  throw new Error(`unsupported flow step kind: ${String(step.kind)}`)
}

function isStepOutputRef(value: unknown): value is { $step: string; field: string } {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as Record<string, unknown>)['$step'] === 'string' &&
    typeof (value as Record<string, unknown>)['field'] === 'string'
  )
}

function resolveCurrentStepOutputRef(
  jobsStore: NonNullable<ResolvedAcpServerDeps['jobsStore']>,
  jobRunId: string,
  phase: JobStepRunPhase,
  ref: { $step: string; field: string }
): string | undefined {
  const stepRun = currentStepRun(jobsStore, jobRunId, phase, ref.$step)
  if (stepRun === undefined || stepRun.status !== 'succeeded') {
    return undefined
  }

  const value = stepRun.result?.[ref.field]
  return typeof value === 'string' ? value : undefined
}

function resolveNativeStepDef(input: {
  jobsStore: NonNullable<ResolvedAcpServerDeps['jobsStore']>
  jobRun: JobRunRecord
  phase: JobStepRunPhase
  step: JobFlowStep
}): {
  stepDef: Readonly<Record<string, unknown>>
  resolvedFields: Readonly<Record<string, string>>
} {
  const resolvedFields: Record<string, string> = {}
  const canonicalEventId = readCanonicalEventId(input.jobRun)
  if (canonicalEventId !== undefined) {
    resolvedFields['_canonicalEventId'] = canonicalEventId
  }

  const resolveValue = (value: unknown): unknown => {
    if (isStepOutputRef(value)) {
      const resolved = resolveCurrentStepOutputRef(
        input.jobsStore,
        input.jobRun.jobRunId,
        input.phase,
        {
          $step: value.$step,
          field: value.field,
        }
      )
      if (resolved === undefined) {
        throw new Error(`unresolved step output ref ${value.$step}.${value.field}`)
      }
      resolvedFields[`${value.$step}.${value.field}`] = resolved
      return resolved
    }
    if (typeof value === 'string') {
      return resolveNativeContentTemplate(input.jobsStore, input.jobRun, input.phase, value)
    }
    if (Array.isArray(value)) {
      return value.map(resolveValue)
    }
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
          key,
          resolveValue(nested),
        ])
      )
    }
    return value
  }

  const resolved = resolveValue(input.step) as Record<string, unknown>
  if (input.step.kind === 'agent-dispatch') {
    const dispatchInput = resolved['input']
    if (
      dispatchInput !== null &&
      typeof dispatchInput === 'object' &&
      !Array.isArray(dispatchInput)
    ) {
      const content = (dispatchInput as Record<string, unknown>)['content']
      if (typeof content === 'string') {
        resolved['content'] = content
      }
    }
  }
  if (
    input.step.kind === 'wrkq-task' &&
    resolved['description'] === undefined &&
    typeof input.jobRun.resolvedInput?.['content'] === 'string'
  ) {
    resolved['description'] = input.jobRun.resolvedInput['content']
  }

  return { stepDef: resolved, resolvedFields }
}

const NATIVE_TEMPLATE_PATTERN = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g

function resolveNativeContentTemplate(
  jobsStore: NonNullable<ResolvedAcpServerDeps['jobsStore']>,
  jobRun: JobRunRecord,
  phase: JobStepRunPhase,
  value: string
): string {
  return value.replace(NATIVE_TEMPLATE_PATTERN, (match, name: string) => {
    if (name.startsWith('input.')) {
      const field = name.slice('input.'.length)
      const resolved = jobRun.resolvedInput?.[field]
      return typeof resolved === 'string' ? resolved : match
    }
    const [stepId, field, ...rest] = name.split('.')
    if (stepId === undefined || field === undefined || rest.length > 0) {
      return match
    }
    const resolved = resolveCurrentStepOutputRef(jobsStore, jobRun.jobRunId, phase, {
      $step: stepId,
      field,
    })
    return resolved ?? match
  })
}

function readCanonicalEventId(jobRun: JobRunRecord): string | undefined {
  const source = jobRun.source
  if (source === undefined) {
    return undefined
  }
  const canonical = source['canonicalEventId']
  if (typeof canonical === 'string') {
    return canonical
  }
  const sourceName = source['source']
  const eventId = source['eventId']
  if (typeof sourceName === 'string' && typeof eventId === 'string') {
    return `${sourceName}:${eventId}`
  }
  return undefined
}

function resolveNativeStepExecutorDeps(
  deps: ResolvedAcpServerDeps,
  jobsStore: NonNullable<ResolvedAcpServerDeps['jobsStore']>
): NativeStepExecutorDeps {
  if (deps.nativeStepExecutor !== undefined) {
    return { store: jobsStore, ...deps.nativeStepExecutor }
  }
  if (deps.workClient === undefined) {
    throw new Error('native step executor requires a work client')
  }

  const workClient = deps.workClient

  return {
    store: jobsStore,
    wrkqTaskPort: {
      createOrFind: (input) => createOrFindWrkqTask(workClient, input),
    },
    sendPulpitMessage: async (input) => {
      const response = await handleCreateAgentPulpitMessage({
        request: new Request('http://acp.local/v1/agent-pulpit/messages', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            idempotencyKey: input.idempotencyKey,
            text: input.text,
            ...(input.bindingId !== undefined ? { bindingId: input.bindingId } : {}),
          }),
        }),
        url: new URL('http://acp.local/v1/agent-pulpit/messages'),
        params: {},
        deps,
        actor: deps.defaultActor,
      })
      if (!response.ok) {
        throw new Error(`pulpit message failed with ${response.status}`)
      }
      const payload = (await response.json()) as {
        delivery: { deliveryRequestId: string; bindingId: string }
      }
      return {
        deliveryRequestId: payload.delivery.deliveryRequestId,
        bindingId: payload.delivery.bindingId,
      }
    },
    dispatchAgentInput: async (input) => {
      const response = await handleCreateInput({
        request: new Request('http://acp.local/v1/inputs', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sessionRef: { scopeRef: input.scopeRef, laneRef: input.laneRef },
            idempotencyKey: input.idempotencyKey,
            content: input.content,
            ...(input.meta !== undefined ? { meta: input.meta } : {}),
          }),
        }),
        url: new URL('http://acp.local/v1/inputs'),
        params: {},
        deps,
        actor: deps.defaultActor,
      })
      if (!response.ok) {
        throw new Error(`agent dispatch failed with ${response.status}`)
      }
      const payload = (await response.json()) as {
        inputAttempt: { inputAttemptId: string }
        run?: { runId: string } | undefined
        targetRun?: { runId: string } | undefined
      }
      const runId = payload.run?.runId ?? payload.targetRun?.runId
      if (runId === undefined) {
        throw new Error('agent dispatch did not return a run id')
      }
      return {
        inputAttemptId: payload.inputAttempt.inputAttemptId,
        runId,
      }
    },
  }
}

function readExecStepResult(stepRun: JobStepRunRecord): ExecStepResult | undefined {
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

function readProbeStepResult(stepRun: JobStepRunRecord): ProbeStepResult | undefined {
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

async function resolveExecDefaultCwd(deps: ResolvedAcpServerDeps, job: JobRecord): Promise<string> {
  const placement = deps.runtimeResolver
    ? await deps.runtimeResolver({ scopeRef: job.scopeRef, laneRef: job.laneRef as LaneRef })
    : undefined

  return placement?.cwd ?? placement?.projectRoot ?? process.cwd()
}

function requireStepInput(step: AgentRunnableStep): string {
  const input = step.input?.trim()
  if (input === undefined || input.length === 0) {
    throw new Error(`flow step ${step.id} input must be a non-empty string`)
  }

  return input
}

async function rotateFreshStepContext(
  deps: ResolvedAcpServerDeps,
  job: JobRecord,
  step: JobFlowStep,
  rotateContext: boolean
): Promise<void> {
  if (!rotateContext || step.fresh !== true || deps.hrcClient === undefined) {
    return
  }

  const session = await deps.hrcClient.resolveSession({
    sessionRef: formatCanonicalSessionRef({ scopeRef: job.scopeRef, laneRef: job.laneRef }),
  })
  if (!session.found) {
    // Nothing to clear for a not-yet-provisioned scope.
    return
  }

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
  const stepRun = currentStepRun(jobsStore, jobRunId, phase, stepId)
  if (stepRun === undefined) {
    throw new Error(`job step run not found: ${jobRunId}/${phase}/${stepId}`)
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

function hasAgentStepTimedOut(
  stepRun: JobStepRunRecord,
  step: AgentRunnableStep,
  now: string
): boolean {
  if (step.timeout === undefined || stepRun.startedAt === undefined) {
    return false
  }

  const timeoutMs = parseFreshDurationMs(step.timeout)
  const startedAt = Date.parse(stepRun.startedAt)
  const nowMs = Date.parse(now)
  return (
    timeoutMs !== undefined &&
    Number.isFinite(startedAt) &&
    Number.isFinite(nowMs) &&
    nowMs - startedAt >= timeoutMs
  )
}

function failTimedOutAgentStep(
  input: {
    deps: ResolvedAcpServerDeps
    jobRun: JobRunRecord
    phase: JobStepRunPhase
    step: AgentRunnableStep
    actor: Actor
    now: string
  },
  stepRun: JobStepRunRecord
): JobStepRunRecord {
  const jobsStore = requireJobsStore(input.deps)
  const error = {
    code: 'agent_step_timeout',
    message: `agent step ${input.phase}/${input.step.id} exceeded timeout ${input.step.timeout}`,
  }
  const failedStepRun = jobsStore.jobStepRuns.updateStep(
    input.jobRun.jobRunId,
    input.phase,
    input.step.id,
    stepRun.attempt,
    {
      status: 'failed',
      error,
      completedAt: input.now,
    }
  ).jobStepRun

  jobsStore.updateJobRun(input.jobRun.jobRunId, {
    status: 'failed',
    errorCode: error.code,
    errorMessage: error.message,
    completedAt: input.now,
    leaseOwner: null,
    leaseExpiresAt: null,
    actor: input.actor,
  })

  terminateTimedOutAgentRuntime(input.deps, stepRun.runId, input.actor)
  return failedStepRun
}

function terminateTimedOutAgentRuntime(
  deps: ResolvedAcpServerDeps,
  runId: string | undefined,
  actor: Actor
): void {
  if (runId === undefined || deps.hrcClient === undefined) {
    return
  }

  const run = deps.runStore.getRun(runId)
  if (run?.runtimeId === undefined) {
    return
  }

  let settled = false
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const terminate = Promise.resolve()
    .then(() =>
      deps.hrcClient?.terminate(run.runtimeId as string, {
        dropContinuation: false,
        reason: 'agent_step_timeout',
        source: 'acp-scheduled-job-runner',
        actor: actorToAuditString(actor),
      })
    )
    .catch(() => undefined)
    .finally(() => {
      settled = true
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId)
      }
    })

  const timeout = new Promise<void>((resolve) => {
    timeoutId = setTimeout(() => {
      if (!settled) {
        resolve()
      }
    }, AGENT_STEP_TERMINATE_TIMEOUT_MS)
  })

  void Promise.race([terminate, timeout]).catch(() => undefined)
}

function isTerminalRunStatus(status: Run['status']): status is TerminalRunStatus {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

function reconcileTerminalStepRun(input: {
  deps: ResolvedAcpServerDeps
  jobRunId: string
  phase: JobStepRunPhase
  stepRun: JobStepRunRecord
  step: AgentRunnableStep
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
  jobsStore: NonNullable<ResolvedAcpServerDeps['jobsStore']>,
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
  jobsStore: NonNullable<ResolvedAcpServerDeps['jobsStore']>,
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
