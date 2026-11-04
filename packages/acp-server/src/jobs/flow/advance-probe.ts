import { writeLogLine } from 'acp-core'
import type { ProbeFlowStep, ProbeOutcome, ProbeStepResult } from 'acp-core'

import { HRC_EVENT_LOCAL_NODE_PROBE } from '../hrc-first-turn-missing.js'
import {
  type StepAdvanceInput,
  type StepAdvanceResult,
  markStepRunning,
  settleStep,
} from './step-runs.js'

// Probe steps ask a named, registered probe whether there is work (`work`) or
// not (`idle`); the step's outcome branches route on the answer.

type ProbeRunner = (input: StepAdvanceInput<ProbeFlowStep>) => Promise<{ outcome: ProbeOutcome }>

const PROBE_REGISTRY: Record<string, ProbeRunner> = {
  'hrc-stale-tty-reap.v1': runHrcClientProbe,
  'wrkq-refactor-eligible.v1': runWrkqRefactorEligibilityProbe,
  [HRC_EVENT_LOCAL_NODE_PROBE]: runHrcEventLocalNodeProbe,
}

class ProbeStepError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

export async function advanceProbeStep(
  input: StepAdvanceInput<ProbeFlowStep>
): Promise<StepAdvanceResult> {
  const startedStepRun = markStepRunning(input)

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
    return settleStep(input, startedStepRun.attempt, {
      status: 'succeeded',
      result,
      completedAt: input.now,
    })
  } catch (error) {
    const code = error instanceof ProbeStepError ? error.code : 'probe_failed'
    const message = error instanceof Error ? error.message : 'probe step failed'
    return settleStep(input, startedStepRun.attempt, {
      status: 'failed',
      error: { code, message },
      completedAt: input.now,
    })
  }
}

async function runHrcClientProbe(
  input: StepAdvanceInput<ProbeFlowStep>
): Promise<{ outcome: ProbeOutcome }> {
  const probe = input.deps.hrcClient?.probe
  if (input.deps.hrcClient === undefined) {
    throw new ProbeStepError('probe_unavailable', 'hrcClient probe capability is not configured')
  }

  if (probe === undefined) {
    const staleRuntimes = await input.deps.hrcClient.listRuntimes({ stale: true })
    // An hrcpty seat (T-12046) is a terminal runtime just as a tmux one is.
    const hasStaleTtyRuntime = staleRuntimes.some(
      (runtime) => runtime.transport === 'tmux' || runtime.transport === 'hrcpty'
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

async function runWrkqRefactorEligibilityProbe(
  input: StepAdvanceInput<ProbeFlowStep>
): Promise<{ outcome: ProbeOutcome }> {
  const workClient = input.deps.workClient
  if (workClient === undefined) {
    throw new ProbeStepError('probe_unavailable', 'wrkq client is not configured')
  }

  const projectId = input.job.projectId || process.env['ASP_PROJECT'] || 'agent-control-plane'
  const listed = await workClient.wrkq.task.list({
    path: `${projectId}/refactor-deferred`,
    state: 'open',
    kind: 'task',
    recursive: true,
    limit: 1,
    summary: true,
  })

  return { outcome: listed.items.length > 0 ? 'work' : 'idle' }
}

async function runHrcEventLocalNodeProbe(
  input: StepAdvanceInput<ProbeFlowStep>
): Promise<{ outcome: ProbeOutcome }> {
  const payloadNodeId = input.jobRun.resolvedInput?.['nodeId']
  const identity = input.deps.jobNodeIdentityAuthority?.getDiagnostics()
  const expectedNodeId = identity?.current?.nodeId ?? identity?.baseline?.nodeId

  if (
    typeof payloadNodeId === 'string' &&
    payloadNodeId.length > 0 &&
    expectedNodeId !== undefined &&
    payloadNodeId === expectedNodeId
  ) {
    return { outcome: 'work' }
  }

  const observed =
    typeof payloadNodeId === 'string' && payloadNodeId.length > 0 ? payloadNodeId : '<missing>'
  writeLogLine({
    level: 'warn',
    component: 'job-flow',
    event: 'job_flow.node_tripwire_blocked',
    data: {
      jobRunId: input.jobRun.jobRunId,
      payloadNode: observed,
      hrcNode: expectedNodeId ?? '<unavailable>',
    },
  })
  return { outcome: 'idle' }
}
