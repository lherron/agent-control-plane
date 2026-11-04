import { isTerminalRunStatus } from '../result-block.js'
import { errorCode, errorMessage, errorStatus } from './error-fields.js'
import { jobRunnerTerminateOptions } from './hrc-terminate.js'
import {
  type DispatchedStepRun,
  type FreshStepContext,
  type FreshStepDispatchPlan,
  SCHEDULED_FRESH_PRE_RUN_CLEANUP_DEGRADED,
  isTerminalJobRunStatus,
} from './scheduled-fresh.js'
import { type StepAdvanceInput, requireJobsStore } from './step-runs.js'

// Before a scheduled fresh step rotates, terminate the previous run's HRC
// runtime. An already-gone runtime is success; a timeout or HRC 500 degrades
// (dispatch proceeds and an acp-health event records it); anything else fails
// the step.

type ScheduledFreshCleanupDegradation = Readonly<{
  code: typeof SCHEDULED_FRESH_PRE_RUN_CLEANUP_DEGRADED
  previousRuntimeId: string
  failureCode: string
  message: string
}>

type FreshStepCleanupResult =
  | { ok: true; degradation?: ScheduledFreshCleanupDegradation | undefined }
  | { ok: false; message: string }

export async function cleanupPreviousScheduledFreshStepRuntime(
  input: FreshStepContext & Pick<StepAdvanceInput, 'actor'>,
  plan: Extract<FreshStepDispatchPlan, { ok: true }>
): Promise<FreshStepCleanupResult> {
  // The plan only asks for cleanup of a previous step it already found
  // effectively terminal.
  const previous = plan.previous
  if (!plan.cleanupPrevious || previous === undefined) {
    return { ok: true }
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
    await input.deps.hrcClient.terminate(
      priorRun.runtimeId,
      jobRunnerTerminateOptions('scheduled_fresh_pre_run_cleanup', input.actor)
    )
    cancelCleanedPreviousRunIfNeeded(input, previous, priorRun.runId)
    return { ok: true }
  } catch (error) {
    if (isBenignTerminateError(error)) {
      return { ok: true }
    }
    const message = `failed to clean previous fresh step runtime ${priorRun.runtimeId}: ${errorMessage(error)}`
    if (isDegradableScheduledFreshCleanupError(error)) {
      const degradation = {
        code: SCHEDULED_FRESH_PRE_RUN_CLEANUP_DEGRADED,
        previousRuntimeId: priorRun.runtimeId,
        failureCode: cleanupFailureCode(error),
        message,
      } satisfies ScheduledFreshCleanupDegradation
      emitScheduledFreshCleanupDegraded(input, degradation)
      return { ok: true, degradation }
    }
    return { ok: false, message }
  }
}

// A terminated runtime whose ACP run never settled (its job run already ended)
// is cancelled so it does not read as live.
function cancelCleanedPreviousRunIfNeeded(
  input: FreshStepContext,
  previous: DispatchedStepRun,
  priorRunId: string
): void {
  const previousJobRun = requireJobsStore(input.deps).getJobRun(previous.jobRunId).jobRun
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
  input: FreshStepContext,
  degradation: ScheduledFreshCleanupDegradation
): void {
  const occurredAt = input.jobRun.triggeredAt
  const eventSeq = Date.parse(occurredAt)
  requireJobsStore(input.deps).insertInboxEvent({
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

  if (errorStatus(error) === 500) {
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
