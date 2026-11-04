import type { JobFlowStep, StepExpectation } from 'acp-core'
import type { JobRecord, JobStepRunRecord, JobsStore } from 'acp-jobs-store'
import { formatCanonicalSessionRef, resolveDatabasePath } from 'hrc-core'

import type { ResolvedAcpServerDeps } from '../../deps.js'
import { dispatchStepThroughInputs } from '../dispatch-step.js'
import {
  type RunOutcome,
  evaluateExpectation,
  isTerminalRunStatus,
  mapRunStatusToOutcome,
  parseResultBlock,
} from '../result-block.js'
import { getRunFinalAssistantText } from '../run-final-output.js'
import { failTimedOutAgentStep, hasAgentStepTimedOut } from './agent-step-timeout.js'
import { errorCode, errorMessage, errorStatus } from './error-fields.js'
import { cleanupPreviousScheduledFreshStepRuntime } from './scheduled-fresh-cleanup.js'
import { resolveFreshStepDispatchPlan, stampScheduledFreshMetadata } from './scheduled-fresh.js'
import type { AgentRunnableStep } from './step-kinds.js'
import {
  type StepAdvanceInput,
  type StepAdvanceResult,
  requireJobsStore,
  settleStep,
  updateStepAttempt,
} from './step-runs.js'

// Agent steps dispatch a turn through the input pipeline on first advance, then
// block until the ACP run settles (or the step times out) and reconcile the
// run's outcome against the step's expectations.
export async function advanceAgentStep(
  input: StepAdvanceInput<AgentRunnableStep>
): Promise<StepAdvanceResult> {
  let stepRun = input.stepRun

  if (stepRun.runId === undefined) {
    const dispatchStartedAt = stepRun.startedAt ?? input.now
    const failPreRunCleanup = (message: string) =>
      settleStep(input, stepRun.attempt, {
        status: 'failed',
        inputAttemptId: null,
        runId: null,
        startedAt: dispatchStartedAt,
        error: { code: 'pre_run_cleanup_failed', message },
        completedAt: input.now,
      })

    const freshPlan = resolveFreshStepDispatchPlan({ ...input, dispatchStartedAt })
    if (!freshPlan.ok) {
      return failPreRunCleanup(freshPlan.message)
    }

    const cleanup = await cleanupPreviousScheduledFreshStepRuntime(input, freshPlan)
    if (!cleanup.ok) {
      return failPreRunCleanup(cleanup.message)
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

      stepRun = updateStepAttempt(input, stepRun.attempt, {
        status: 'running',
        inputAttemptId: dispatched.inputAttemptId,
        runId: dispatched.runId,
        startedAt: dispatchStartedAt,
        ...degradationResult,
      })
    } catch (error) {
      if (!isTransientFlowAdvanceError(error)) {
        throw error
      }
      failStepDispatchAttemptAndQueueRetry({
        jobsStore: requireJobsStore(input.deps),
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
    return { state: 'terminal', stepRun: failTimedOutAgentStep(input, stepRun) }
  }

  if (terminal === undefined) {
    return { state: 'blocked' }
  }

  return {
    state: 'terminal',
    stepRun: reconcileTerminalStepRun(input, stepRun, terminal),
  }
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

// A transient dispatch failure fails this attempt and seeds the next one; the
// rethrown error lets the scheduler retry the whole advance.
function failStepDispatchAttemptAndQueueRetry(input: {
  jobsStore: JobsStore
  jobRunId: string
  phase: StepAdvanceInput['phase']
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

function getTerminalRunOutcome(
  deps: ResolvedAcpServerDeps,
  runId: string | undefined
): RunOutcome | undefined {
  if (runId === undefined) {
    return undefined
  }

  const run = deps.runStore.getRun(runId)
  if (run === undefined || !isTerminalRunStatus(run.status)) {
    return undefined
  }

  return mapRunStatusToOutcome(run.status)
}

function reconcileTerminalStepRun(
  input: StepAdvanceInput<AgentRunnableStep>,
  stepRun: JobStepRunRecord,
  runOutcome: RunOutcome
): JobStepRunRecord {
  const expectation: StepExpectation = input.step.expect ?? {}
  const parsedResult =
    expectation.resultBlock === undefined
      ? undefined
      : parseResultBlock(
          readRunFinalAssistantText(input.deps, stepRun.runId),
          expectation.resultBlock
        )
  const evaluation = evaluateExpectation(runOutcome, parsedResult, expectation)

  return updateStepAttempt(input, stepRun.attempt, {
    status: evaluation.ok ? 'succeeded' : 'failed',
    ...(expectation.resultBlock !== undefined ? { resultBlock: expectation.resultBlock } : {}),
    ...(evaluation.result !== undefined ? { result: evaluation.result } : {}),
    ...(evaluation.error !== undefined ? { error: evaluation.error } : { error: null }),
    completedAt: stepRun.completedAt ?? input.now,
  })
}

function readRunFinalAssistantText(deps: ResolvedAcpServerDeps, runId: string | undefined): string {
  if (runId === undefined) {
    return ''
  }

  // Tests point `hrcDbPath` at a fixture HRC database; production resolves it.
  const configured = (deps as ResolvedAcpServerDeps & { hrcDbPath?: string }).hrcDbPath
  return (
    getRunFinalAssistantText(
      {
        getRun: (id) => deps.runStore.getRun(id),
        hrcDbPath: configured ?? resolveDatabasePath(),
      },
      runId
    ) ?? ''
  )
}
