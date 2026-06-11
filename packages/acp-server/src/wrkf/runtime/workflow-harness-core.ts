import { deliverWrkfEffects } from '../effect-delivery.js'
import {
  type ActionRecord,
  type EvidenceRecord,
  type NextActionResponse,
  projectEvidenceRecord,
  projectNextActionResponse,
} from '../projections.js'
import {
  type EvidenceWritePolicy,
  type ParticipantOutput,
  writeEvidenceAndSatisfyObligations,
} from './evidence-writer.js'
import { type CapturePort, captureAndIngest } from './participant-capture.js'
import type { WorkflowPack } from './workflow-pack.js'

const DEFAULT_MAX_TURNS = 50
const CAS_RETRY_ERROR_CODES = ['WRKF_STALE_REVISION', 'WRKF_CONTEXT_MISMATCH']

export interface WorkflowHarnessPort extends CapturePort {
  run: {
    start(params: {
      task: string
      role: string
      actor?: unknown
      idempotencyKey?: string
      lane?: string
      deliveryRef?: string
    }): Promise<unknown>
    finish(params: { runId: string; status?: string; summary?: string }): Promise<unknown>
    fail(params: { runId: string; summary?: string }): Promise<unknown>
    bindExternal(params: Record<string, unknown>): Promise<unknown>
  }
  transition: {
    apply(params: {
      task: string
      transition: string
      role?: string
      actor?: unknown
      expectRevision?: number
      contextHash?: string
      idempotencyKey?: string
      runChecks?: boolean
      dryRun?: boolean
    }): Promise<unknown>
  }
  effect: {
    list(params: { task: string }): Promise<unknown>
    deliver(params: { effectId: string; adapter: string }): Promise<unknown>
  }
}

export type TransitionPolicy = 'none' | 'single-safe'

export interface WorkflowRunStepRequest {
  task: string
  role?: string
  actor: string
  idempotencyKey: string
  launchRuntime?: boolean
  participantOutput?: ParticipantOutput
  transitionPolicy?: TransitionPolicy
  scopeRef?: string
  laneRef?: string
}

export interface WorkflowApproveTransitionRequest {
  task: string
  transition: string
  role?: string
  actor: string
  routeKey: string
  runChecks?: boolean
}

export interface WorkflowRunUntilBlockedRequest {
  task: string
  actor: string
  reviewerActor?: string
  alternateActor?: string
  idempotencyKey: string
  maxTurns?: number
  allowExplicitOnly?: boolean
  allowSimulation?: boolean
}

export interface WorkflowHarnessResult {
  task: string
  workflowRef: string
  instance: {
    status: string
    phase: string
    revision: number
    contextHash: string
    stale?: boolean
  }
  next: {
    actions: unknown[]
    blockedTransitions: unknown[]
    openObligations: unknown[]
    pendingEffects: unknown[]
  }
  runs: {
    started?: unknown
    boundExternal?: unknown
    finished?: unknown
    failed?: unknown
  }
  evidenceAdded: unknown[]
  obligationsSatisfied: unknown[]
  transitionApplied?: unknown
  effectsDelivered: unknown[]
  stopReason?: string
  diagnostics: string[]
}

export interface WorkflowHarnessOptions {
  workflowRef: string
  pack: WorkflowPack
  evidencePolicy?: EvidenceWritePolicy | undefined
}

export async function runWorkflowStep(
  port: WorkflowHarnessPort,
  options: WorkflowHarnessOptions,
  input: WorkflowRunStepRequest
): Promise<WorkflowHarnessResult> {
  const role = input.role ?? 'agent'
  const transitionPolicy: TransitionPolicy = input.transitionPolicy ?? 'none'
  const launchRuntime = input.launchRuntime === true
  const result = emptyResult(input.task, options.workflowRef)

  let latestNext = await readNext(port, input.task, role)
  applyNext(result, latestNext)

  const startedRun = await port.run.start({
    task: input.task,
    role,
    actor: input.actor,
    idempotencyKey: `${input.idempotencyKey}:run:${latestNext.instance.revision}`,
    ...(input.scopeRef !== undefined ? { deliveryRef: input.scopeRef } : {}),
    ...(input.laneRef !== undefined ? { lane: input.laneRef } : {}),
  })
  result.runs.started = startedRun

  if (launchRuntime) {
    result.diagnostics.push('launched-runtime: awaiting participant output')
    return result
  }

  const runId = recordId(startedRun)
  const captureKey = makeCaptureKey(input.idempotencyKey, input.task)
  try {
    const capture = await captureAndIngest(port, {
      captureKey,
      mode: 'supplied',
      ingest: () =>
        writeEvidenceAndSatisfyObligations(
          port,
          {
            task: input.task,
            role,
            actor: input.actor,
            participantOutput: input.participantOutput ?? { evidence: [] },
          },
          options.evidencePolicy
        ),
    })
    result.evidenceAdded = capture.evidenceAdded
    result.obligationsSatisfied = capture.obligationsSatisfied
    if (capture.next !== undefined) {
      latestNext = capture.next
      applyNext(result, latestNext)
    }

    result.runs.finished = await port.run.finish({
      runId,
      status: 'completed',
      ...(input.participantOutput?.summary !== undefined
        ? { summary: input.participantOutput.summary }
        : {}),
    })
  } catch (error) {
    result.runs.failed = await port.run.fail({ runId })
    throw error
  }

  if (transitionPolicy === 'single-safe') {
    const chosen = await chooseFromCurrent(options.pack, {
      port,
      task: input.task,
      next: latestNext,
      actor: input.actor,
      role,
      allowExplicitOnly: false,
    })
    if (chosen?.blockedReason !== undefined) {
      result.diagnostics.push(chosen.blockedReason)
    } else if (chosen !== undefined) {
      result.transitionApplied = await applyFreshTransition(port, {
        task: input.task,
        transition: chosen.transition,
        role,
        actor: chosen.actor ?? input.actor,
        next: latestNext,
        idempotencyKey: `${input.idempotencyKey}:transition:${chosen.transition}:${latestNext.instance.revision}`,
        runChecks: false,
      })
      result.effectsDelivered.push(...(await deliverEffects(port, input.task)))

      latestNext = await readNext(port, input.task, role)
      applyNext(result, latestNext)
    }
  }

  return result
}

export async function approveWorkflowTransition(
  port: WorkflowHarnessPort,
  options: WorkflowHarnessOptions,
  input: WorkflowApproveTransitionRequest
): Promise<WorkflowHarnessResult> {
  const role = input.role ?? 'agent'
  const runChecks = input.runChecks ?? false
  const result = emptyResult(input.task, options.workflowRef)

  let fresh = await readNext(port, input.task, role)
  applyNext(result, fresh)

  let applied: unknown
  let retried = false
  for (;;) {
    try {
      applied = await applyFreshTransition(port, {
        task: input.task,
        transition: input.transition,
        role,
        actor: input.actor,
        next: fresh,
        idempotencyKey: `${input.routeKey}:transition:${input.transition}:${fresh.instance.revision}`,
        runChecks,
      })
      break
    } catch (error) {
      if (!retried && isCasRetryError(error)) {
        retried = true
        fresh = await readNext(port, input.task, role)
        applyNext(result, fresh)
        continue
      }
      throw error
    }
  }
  result.transitionApplied = applied

  result.effectsDelivered.push(...(await deliverEffects(port, input.task)))

  const latest = await readNext(port, input.task, role)
  applyNext(result, latest)

  return result
}

export async function runWorkflowUntilBlocked(
  port: WorkflowHarnessPort,
  options: WorkflowHarnessOptions,
  input: WorkflowRunUntilBlockedRequest
): Promise<WorkflowHarnessResult> {
  const maxTurns = input.maxTurns ?? DEFAULT_MAX_TURNS
  const result = emptyResult(input.task, options.workflowRef)
  let stopReason: string | undefined

  let turns = 0
  while (turns < maxTurns) {
    turns++

    let next = await readNext(port, input.task, 'agent')
    applyNext(result, next)

    const workerDecision = await options.pack.workerPolicy?.({
      task: input.task,
      next,
      actor: input.actor,
      ...(input.alternateActor !== undefined ? { alternateActor: input.alternateActor } : {}),
      ...(input.reviewerActor !== undefined ? { reviewerActor: input.reviewerActor } : {}),
      ...(input.allowSimulation !== undefined ? { allowSimulation: input.allowSimulation } : {}),
    })

    if (workerDecision?.kind === 'stop') {
      stopReason = workerDecision.reason
      break
    }

    if (workerDecision?.kind === 'write-output') {
      const ingest = await writeEvidenceAndSatisfyObligations(
        port,
        {
          task: input.task,
          role: workerDecision.role,
          actor: workerDecision.actor,
          participantOutput: workerDecision.participantOutput,
        },
        options.evidencePolicy
      )
      result.evidenceAdded.push(...ingest.evidenceAdded)
      result.obligationsSatisfied.push(...ingest.obligationsSatisfied)
      next = ingest.next
      applyNext(result, next)
    }

    const fresh = await readNext(port, input.task, 'agent')
    applyNext(result, fresh)
    const chosen = await chooseFromCurrent(options.pack, {
      port,
      task: input.task,
      next: fresh,
      actor: input.actor,
      role: 'agent',
      ...(input.alternateActor !== undefined ? { alternateActor: input.alternateActor } : {}),
      ...(input.reviewerActor !== undefined ? { reviewerActor: input.reviewerActor } : {}),
      allowExplicitOnly: input.allowExplicitOnly === true,
    })
    if (chosen === undefined) {
      stopReason = 'blocked_or_ambiguous'
      break
    }
    if (chosen.blockedReason !== undefined) {
      stopReason = chosen.blockedReason
      break
    }

    result.transitionApplied = await applyFreshTransition(port, {
      task: input.task,
      transition: chosen.transition,
      role: 'agent',
      actor: chosen.actor ?? input.actor,
      next: fresh,
      idempotencyKey: `${input.idempotencyKey}:transition:${chosen.transition}:${fresh.instance.revision}`,
      runChecks: false,
    })

    result.effectsDelivered.push(...(await deliverEffects(port, input.task)))
  }

  result.stopReason = stopReason ?? 'max_turns'
  return result
}

export async function applyFreshTransition(
  port: WorkflowHarnessPort,
  input: {
    task: string
    transition: string
    role: string
    actor: string
    next: NextActionResponse
    idempotencyKey: string
    runChecks: boolean
  }
): Promise<unknown> {
  return port.transition.apply({
    task: input.task,
    transition: input.transition,
    role: input.role,
    actor: input.actor,
    expectRevision: input.next.instance.revision,
    contextHash: input.next.instance.contextHash ?? '',
    idempotencyKey: input.idempotencyKey,
    runChecks: input.runChecks,
  })
}

export async function readNext(
  port: WorkflowHarnessPort,
  task: string,
  role?: string
): Promise<NextActionResponse> {
  const raw = await port.next({ task, ...(role !== undefined ? { role } : {}) })
  return projectNextActionResponse(raw)
}

export function applyNext(result: WorkflowHarnessResult, next: NextActionResponse): void {
  const instance = next.instance
  result.instance = {
    status: instance.state.status,
    phase: instance.state.phase,
    revision: instance.revision,
    contextHash: instance.contextHash ?? '',
    ...(instance.stale !== undefined ? { stale: instance.stale } : {}),
  }
  result.next = {
    actions: next.actions,
    blockedTransitions: next.blockedTransitions,
    openObligations: next.openObligations,
    pendingEffects: next.pendingEffects,
  }
}

export function realTransitionNames(actions: ActionRecord[]): string[] {
  return actions
    .filter((action) => action.kind === 'transition' || action.kind === undefined)
    .map((action) => action.transition)
    .filter((transition): transition is string => typeof transition === 'string')
}

export function makeCaptureKey(routeKey: string, task: string): string {
  return `${routeKey}:participant-output:${task}`
}

async function chooseFromCurrent(
  pack: WorkflowPack,
  input: {
    port: WorkflowHarnessPort
    task: string
    next: NextActionResponse
    actor: string
    role: string
    alternateActor?: string | undefined
    reviewerActor?: string | undefined
    allowExplicitOnly: boolean
  }
): Promise<
  | { transition: string; actor?: string | undefined; blockedReason?: undefined }
  | { blockedReason: string }
  | undefined
> {
  if (pack.chooseTransition === undefined) {
    return undefined
  }
  const candidates = realTransitionNames(input.next.actions)
  const evidenceTimeline =
    pack.needsEvidenceTimeline === true
      ? await readEvidenceTimeline(input.port, input.task)
      : undefined
  const chosen = await pack.chooseTransition({
    next: input.next,
    actor: input.actor,
    role: input.role,
    ...(input.alternateActor !== undefined ? { alternateActor: input.alternateActor } : {}),
    ...(input.reviewerActor !== undefined ? { reviewerActor: input.reviewerActor } : {}),
    allowExplicitOnly: input.allowExplicitOnly,
    candidateTransitions: candidates,
    ...(evidenceTimeline !== undefined ? { evidenceTimeline } : {}),
  })
  if (chosen === undefined) {
    return undefined
  }
  if (typeof chosen === 'string') {
    return { transition: chosen }
  }
  if ('blocked' in chosen) {
    return { blockedReason: chosen.reason }
  }
  return chosen
}

async function readEvidenceTimeline(
  port: WorkflowHarnessPort,
  task: string
): Promise<EvidenceRecord[]> {
  const list = optionalEvidenceList(port)
  if (list === undefined) {
    return []
  }
  const raw = await list({ task })
  if (!Array.isArray(raw)) {
    return []
  }
  return raw.map((entry, index) => projectEvidenceRecord(entry, `evidenceTimeline[${index}]`))
}

function optionalEvidenceList(
  port: WorkflowHarnessPort
): ((params: { task: string }) => Promise<unknown>) | undefined {
  const evidence = port.evidence as unknown as Record<string, unknown>
  const list = evidence['list']
  return typeof list === 'function'
    ? (list as (params: { task: string }) => Promise<unknown>)
    : undefined
}

async function deliverEffects(
  port: WorkflowHarnessPort,
  task: string
): Promise<Array<{ id: string }>> {
  const delivery = await deliverWrkfEffects(port, { task })
  return delivery.delivered.map((id) => ({ id }))
}

function emptyResult(task: string, workflowRef: string): WorkflowHarnessResult {
  return {
    task,
    workflowRef,
    instance: { status: '', phase: '', revision: 0, contextHash: '' },
    next: { actions: [], blockedTransitions: [], openObligations: [], pendingEffects: [] },
    runs: {},
    evidenceAdded: [],
    obligationsSatisfied: [],
    effectsDelivered: [],
    diagnostics: [],
  }
}

function recordId(record: unknown): string {
  if (typeof record === 'object' && record !== null) {
    const id = (record as Record<string, unknown>)['id']
    if (typeof id === 'string') {
      return id
    }
  }
  return ''
}

function isCasRetryError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false
  }
  const maybe = error as { code?: unknown; message?: unknown }
  if (typeof maybe.code === 'string' && CAS_RETRY_ERROR_CODES.includes(maybe.code)) {
    return true
  }
  if (
    typeof maybe.message === 'string' &&
    CAS_RETRY_ERROR_CODES.some((code) => (maybe.message as string).includes(code))
  ) {
    return true
  }
  return false
}
