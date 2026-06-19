import type {
  Actor,
  ExecFlowStep,
  ExecStepResult,
  FlowNext,
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
  type NativeStepExecutorDeps,
  executeNativeSideEffectStep,
  resolveStepOutputRef,
  validateJobFlow,
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

    const transition = resolveTerminalStepTransition(step, stepRun)
    const next = resolvePhaseTransition(input.steps, stepById, step, transition)
    if (next.state !== 'advance') {
      return next
    }
    currentStep = next.step
  }

  return { state: 'succeeded' }
}

type StepAdvanceResult = { state: 'terminal'; stepRun: JobStepRunRecord } | { state: 'blocked' }

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
    const content = requireStepInput(input.step)
    await rotateFreshStepContext(input.deps, input.job, input.step)
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

    stepRun = jobsStore.jobStepRuns.updateStep(
      input.jobRun.jobRunId,
      input.phase,
      input.step.id,
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
    const status = result.exitCode === 0 && !result.timedOut ? 'succeeded' : 'failed'

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

type ResolvedPhaseTransition =
  | { state: 'advance'; step: JobFlowStep | undefined }
  | { state: 'succeeded' }
  | { state: 'failed' }

function resolveTerminalStepTransition(
  step: JobFlowStep,
  stepRun: JobStepRunRecord
): PhaseTransition {
  if (isExecStep(step)) {
    const result = readExecStepResult(stepRun)
    if (result?.exitCode !== null && result?.exitCode !== undefined) {
      const exitCodeTarget = step.branches?.exitCode?.[String(result.exitCode)]
      if (exitCodeTarget !== undefined) {
        return exitCodeTarget
      }
    }

    if (step.branches?.default !== undefined) {
      return step.branches.default
    }
  }

  if (step.next !== undefined) {
    return step.next
  }

  if (isExecStep(step)) {
    const result = readExecStepResult(stepRun)
    return result?.exitCode === 0 && result.timedOut !== true ? 'continue' : 'fail'
  }

  return stepRun.status === 'succeeded' ? 'continue' : 'fail'
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

function isNativeStep(step: JobFlowStep): boolean {
  return (
    step.kind === 'wrkq-task' ||
    step.kind === 'pulpit-message' ||
    step.kind === 'agent-dispatch'
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

function resolveNativeStepDef(input: {
  jobsStore: NonNullable<ResolvedAcpServerDeps['jobsStore']>
  jobRun: JobRunRecord
  phase: JobStepRunPhase
  step: JobFlowStep
}): { stepDef: Readonly<Record<string, unknown>>; resolvedFields: Readonly<Record<string, string>> } {
  const resolvedFields: Record<string, string> = {}
  const canonicalEventId = readCanonicalEventId(input.jobRun)
  if (canonicalEventId !== undefined) {
    resolvedFields['_canonicalEventId'] = canonicalEventId
  }

  const resolveValue = (value: unknown): unknown => {
    if (isStepOutputRef(value)) {
      const resolved = resolveStepOutputRef(input.jobsStore, input.jobRun.jobRunId, input.phase, {
        $step: value.$step,
        field: value.field,
      })
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
    const resolved = resolveStepOutputRef(jobsStore, jobRun.jobRunId, phase, {
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

  return {
    store: jobsStore,
    wrkqTaskPort: {
      createOrFind: (input) => createOrFindWrkqTask(deps.workClient!, input),
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
  step: JobFlowStep
): Promise<void> {
  if (step.fresh !== true || deps.hrcClient === undefined) {
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
