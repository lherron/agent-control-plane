import type { Actor } from 'acp-core'
import { type JobStepRunRecord, parseFreshDurationMs } from 'acp-jobs-store'

import type { ResolvedAcpServerDeps } from '../../deps.js'
import { jobRunnerTerminateOptions } from './hrc-terminate.js'
import type { AgentRunnableStep } from './step-kinds.js'
import { type StepAdvanceInput, requireJobsStore, updateStepAttempt } from './step-runs.js'

// An agent step with `timeout` that is still running past it fails the step and
// the job run, and the job runner terminates its HRC runtime without waiting.

const AGENT_STEP_TERMINATE_TIMEOUT_MS = 50

export function hasAgentStepTimedOut(
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

export function failTimedOutAgentStep(
  input: StepAdvanceInput<AgentRunnableStep>,
  stepRun: JobStepRunRecord
): JobStepRunRecord {
  const error = {
    code: 'agent_step_timeout',
    message: `agent step ${input.phase}/${input.step.id} exceeded timeout ${input.step.timeout}`,
  }
  const failedStepRun = updateStepAttempt(input, stepRun.attempt, {
    status: 'failed',
    error,
    completedAt: input.now,
  })

  requireJobsStore(input.deps).updateJobRun(input.jobRun.jobRunId, {
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
      deps.hrcClient?.terminate(
        run.runtimeId as string,
        jobRunnerTerminateOptions('agent_step_timeout', actor)
      )
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
