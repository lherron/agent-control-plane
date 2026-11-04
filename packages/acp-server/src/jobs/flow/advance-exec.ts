import type { ExecFlowStep } from 'acp-core'
import type { JobRecord } from 'acp-jobs-store'
import type { LaneRef } from 'agent-scope'

import type { ResolvedAcpServerDeps } from '../../deps.js'
import { resolveJobExecPolicy } from '../exec-policy.js'
import { ExecStepError, runExecStep } from '../exec-step.js'
import { isSuccessfulExecStepResult } from './step-kinds.js'
import {
  type StepAdvanceInput,
  type StepAdvanceResult,
  markStepRunning,
  settleStep,
} from './step-runs.js'

// Exec steps run a local command in-process and settle in the same advance.
export async function advanceExecStep(
  input: StepAdvanceInput<ExecFlowStep>
): Promise<StepAdvanceResult> {
  const startedStepRun = markStepRunning(input)

  try {
    const defaultCwd = await resolveExecDefaultCwd(input.deps, input.job)
    const jobExecPolicy = input.deps.jobExecPolicy ?? resolveJobExecPolicy()
    const result = await runExecStep({
      step: input.step,
      defaultCwd,
      // Exec steps are at-least-once across daemon crashes: a stored running step
      // can be re-spawned after restart, so flow definitions should keep exec
      // side effects idempotent.
      policy: {
        ...jobExecPolicy,
        allowedCwdRoots: [...jobExecPolicy.allowedCwdRoots, defaultCwd],
      },
    })
    const status = isSuccessfulExecStepResult(input.step, result) ? 'succeeded' : 'failed'

    return settleStep(input, startedStepRun.attempt, {
      status,
      result: result as unknown as Readonly<Record<string, unknown>>,
      error: result.timedOut ? { code: 'exec_timeout', message: 'exec step timed out' } : null,
      completedAt: result.completedAt,
    })
  } catch (error) {
    const code = error instanceof ExecStepError ? error.code : 'exec_spawn_failed'
    const message = error instanceof Error ? error.message : 'exec step failed'
    return settleStep(input, startedStepRun.attempt, {
      status: 'failed',
      error: { code, message },
      completedAt: input.now,
    })
  }
}

async function resolveExecDefaultCwd(deps: ResolvedAcpServerDeps, job: JobRecord): Promise<string> {
  const placement = deps.runtimeResolver
    ? await deps.runtimeResolver({ scopeRef: job.scopeRef, laneRef: job.laneRef as LaneRef })
    : undefined

  return placement?.cwd ?? placement?.projectRoot ?? process.cwd()
}
