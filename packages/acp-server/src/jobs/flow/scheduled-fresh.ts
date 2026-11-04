import type { JobStepRunPhase } from 'acp-core'
import {
  type JobRecord,
  type JobRunRecord,
  type JobStepRunRecord,
  type JobsStore,
  parseFreshDurationMs,
} from 'acp-jobs-store'

import type { ResolvedAcpServerDeps } from '../../deps.js'
import { isRecord } from '../../wrkf/value.js'
import type { AgentRunnableStep } from './step-kinds.js'
import {
  type StepAdvanceInput,
  TERMINAL_STEP_STATUSES,
  currentStepRun,
  requireJobsStore,
} from './step-runs.js'

// Decides how a `fresh: true` agent step dispatches. Unscheduled runs always
// rotate context. Scheduled runs rotate once the previous run's runtime is done,
// and with `freshDuration` keep one context for the whole window, stamped on the
// ACP run that opened it.

export type DispatchedStepRun = JobStepRunRecord & { runId: string }

export type FreshStepContext = Pick<
  StepAdvanceInput<AgentRunnableStep>,
  'deps' | 'job' | 'jobRun' | 'phase' | 'step'
>

type ScheduledFreshMetadata = {
  jobId: string
  phase: JobStepRunPhase
  stepId: string
  freshDuration: string
  windowStartedAt: string
}

export type FreshStepDispatchPlan =
  | {
      ok: true
      rotateContext: boolean
      cleanupPrevious: boolean
      previous?: DispatchedStepRun | undefined
      scheduledFresh?: ScheduledFreshMetadata | undefined
    }
  | { ok: false; message: string }

export const SCHEDULED_FRESH_PRE_RUN_CLEANUP_DEGRADED = 'scheduled_fresh_pre_run_cleanup_degraded'
const SCHEDULED_FRESH_METADATA_KEY = 'scheduledFresh'

const TERMINAL_JOB_RUN_STATUSES = new Set<JobRunRecord['status']>([
  'succeeded',
  'failed',
  'skipped',
])

export function resolveFreshStepDispatchPlan(
  input: FreshStepContext & { dispatchStartedAt: string }
): FreshStepDispatchPlan {
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

export function stampScheduledFreshMetadata(
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

export function isTerminalJobRunStatus(status: JobRunRecord['status']): boolean {
  return TERMINAL_JOB_RUN_STATUSES.has(status)
}

function isPreviousFreshStepEffectivelyTerminal(
  jobsStore: JobsStore,
  previous: DispatchedStepRun
): boolean {
  if (TERMINAL_STEP_STATUSES.has(previous.status)) {
    return true
  }

  const jobRun = jobsStore.getJobRun(previous.jobRunId).jobRun
  return jobRun !== undefined && isTerminalJobRunStatus(jobRun.status)
}

function isScheduledFreshStepDispatch(job: JobRecord, jobRun: JobRunRecord): boolean {
  return (
    job.trigger.kind === 'schedule' &&
    (jobRun.triggeredBy === 'schedule' || jobRun.triggeredBy === 'catch-up')
  )
}

function buildScheduledFreshMetadata(
  input: FreshStepContext,
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
  input: FreshStepContext
): ScheduledFreshMetadata | undefined {
  if (
    !isRecord(value) ||
    value['jobId'] !== input.job.jobId ||
    value['phase'] !== input.phase ||
    value['stepId'] !== input.step.id ||
    value['freshDuration'] !== input.step.freshDuration ||
    typeof value['windowStartedAt'] !== 'string'
  ) {
    return undefined
  }

  return {
    jobId: value['jobId'],
    phase: value['phase'],
    stepId: value['stepId'],
    freshDuration: value['freshDuration'],
    windowStartedAt: value['windowStartedAt'],
  } as ScheduledFreshMetadata
}

// The most recent other run of this job whose step reached dispatch, skipping
// runs whose own pre-run cleanup degraded (their predecessor runtime may live).
function findPreviousDispatchedStepRun(input: {
  jobsStore: JobsStore
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

    return stepRun as DispatchedStepRun
  }

  return undefined
}

function hasScheduledFreshCleanupDegradation(stepRun: JobStepRunRecord): boolean {
  const degradation = isRecord(stepRun.degradation)
    ? stepRun.degradation
    : isRecord(stepRun.result?.['degradation'])
      ? stepRun.result['degradation']
      : undefined
  return degradation?.['code'] === SCHEDULED_FRESH_PRE_RUN_CLEANUP_DEGRADED
}
