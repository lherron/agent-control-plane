import { deliverWrkfEffects } from '../wrkf/effect-delivery.js'
import { parsePbcParticipantOutput } from '../wrkf/packs/pbc/output-parser.js'
import { choosePbcTransition } from '../wrkf/packs/pbc/transition-policy.js'
import { pbcWorkerPolicy } from '../wrkf/packs/pbc/worker-policy.js'
import { captureAndIngestParticipantOutput } from '../wrkf/participant-output.js'
import {
  type EvidenceRecord,
  type NextActionResponse,
  projectEvidenceRecord,
  projectNextActionResponse,
} from '../wrkf/projections.js'

const DEFAULT_MAX_TURNS = 20
const DEFAULT_LEASE_MS = 5 * 60 * 1000

export type PbcContinuationWorkerFinalStatus = 'succeeded' | 'failed'

export type PbcContinuationWorkerInput = {
  taskId: string
  idempotencyKey: string
  actor: string
  pressureActor?: string | undefined
  alternateActor?: string | undefined
  maxTurns?: number | undefined
  jobId?: string | undefined
  leaseOwner?: string | undefined
  leaseMs?: number | undefined
}

export type PbcContinuationWorkerResult = {
  taskId: string
  turnsCompleted: number
  stopReason: string
  finalStatus: PbcContinuationWorkerFinalStatus
  finalRevision?: number | undefined
}

export interface PbcContinuationWorkerPort {
  next(params: { task: string; role?: string }): Promise<unknown>
  evidence: {
    list?(params: { task: string }): Promise<unknown[]>
    add(params: {
      task: string
      kind: string
      ref?: string
      summary?: string
      facts?: Record<string, unknown>
      data?: unknown
      actor?: string
      role?: string
    }): Promise<unknown>
  }
  obligation: {
    list(params: { task: string }): Promise<unknown[]>
    satisfy(params: {
      task: string
      id: string
      evidenceId?: string
      role?: string
      actor?: string
    }): Promise<unknown>
  }
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
    }): Promise<unknown>
  }
  effect: {
    list(params: { task: string }): Promise<unknown>
    deliver(params: { effectId: string; adapter: string }): Promise<unknown>
  }
  captures: {
    get(captureKey: string): Promise<unknown>
    set(captureKey: string, record: unknown): Promise<void>
  }
  launchAcpRun(params: {
    taskId: string
    role: string
    actor: string
    idempotencyKey: string
    prompt?: string
  }): Promise<{ acpRunId: string }>
  getFinalAssistantText(acpRunId: string): string | undefined | Promise<string | undefined>
  jobs?: {
    acquireLease?(params: {
      jobId: string
      leaseOwner: string
      leaseExpiresAt: string
    }): { acquired: boolean; job?: unknown } | Promise<{ acquired: boolean; job?: unknown }>
    transition?(params: {
      jobId: string
      toStatus: 'succeeded' | 'failed' | 'cancelled'
      resultJson?: unknown
      errorJson?: unknown
      stopReason?: string
    }): unknown | Promise<unknown>
  }
}

export async function runPbcContinuationWorker(
  port: PbcContinuationWorkerPort,
  input: PbcContinuationWorkerInput
): Promise<PbcContinuationWorkerResult> {
  if (input.jobId !== undefined && port.jobs?.acquireLease !== undefined) {
    const lease = await port.jobs.acquireLease({
      jobId: input.jobId,
      leaseOwner: input.leaseOwner ?? 'pbc-continuation-worker',
      leaseExpiresAt: new Date(Date.now() + (input.leaseMs ?? DEFAULT_LEASE_MS)).toISOString(),
    })
    if (!lease.acquired) {
      const result = resultFor(input.taskId, 0, 'lease_not_acquired', 'failed')
      await persistJobResult(port, input, result)
      return result
    }
  }

  let result: PbcContinuationWorkerResult
  try {
    result = await runLoop(port, input)
  } catch (error) {
    result = resultFor(input.taskId, 0, errorMessage(error), 'failed')
  }

  await persistJobResult(port, input, result)
  return result
}

async function runLoop(
  port: PbcContinuationWorkerPort,
  input: PbcContinuationWorkerInput
): Promise<PbcContinuationWorkerResult> {
  const maxTurns = Math.max(0, Math.floor(input.maxTurns ?? DEFAULT_MAX_TURNS))
  let turnsCompleted = 0
  let latestNext: NextActionResponse | undefined

  while (turnsCompleted < maxTurns) {
    const next = await readNext(port, input.taskId, 'agent')
    latestNext = next

    const policy = await pbcWorkerPolicy({
      task: input.taskId,
      next,
      actor: input.actor,
      ...(input.alternateActor !== undefined ? { alternateActor: input.alternateActor } : {}),
      ...(input.pressureActor !== undefined ? { reviewerActor: input.pressureActor } : {}),
      allowSimulation: false,
    })

    if (policy.kind === 'stop') {
      return resultFor(input.taskId, turnsCompleted, policy.reason, 'succeeded', latestNext)
    }

    const participant = participantFor(input, next)
    const run = await port.run.start({
      task: input.taskId,
      role: participant.role,
      actor: participant.actor,
      idempotencyKey: `${input.idempotencyKey}:run:${next.instance.revision}`,
    })
    const wrkfRunId = recordId(run)

    const launch = await port.launchAcpRun({
      taskId: input.taskId,
      role: participant.role,
      actor: participant.actor,
      idempotencyKey: `${input.idempotencyKey}:launch:${next.instance.revision}`,
      prompt: compileWorkerPrompt(input.taskId, participant.role, participant.actor, next),
    })

    await port.run.bindExternal({
      runId: wrkfRunId,
      externalRunRef: launch.acpRunId,
      idempotencyKey: `${input.idempotencyKey}:bindExternal:${next.instance.revision}`,
    })

    const finalText = await port.getFinalAssistantText(launch.acpRunId)
    if (finalText === undefined || finalText.trim().length === 0) {
      await port.run.fail({ runId: wrkfRunId, summary: 'no final assistant text available' })
      return resultFor(input.taskId, turnsCompleted, 'missing_final_assistant_text', 'failed', next)
    }

    try {
      const participantOutput = await parsePbcParticipantOutput({
        text: finalText,
        role: participant.role,
        actor: participant.actor,
        next,
      })
      const capture = await captureAndIngestParticipantOutput(
        port as Parameters<typeof captureAndIngestParticipantOutput>[0],
        {
          task: input.taskId,
          role: participant.role,
          actor: participant.actor,
          captureKey: `${input.idempotencyKey}:participant-output:${input.taskId}`,
          mode: 'supplied',
          participantOutput,
        }
      )
      if (capture.next !== undefined) {
        latestNext = capture.next
      }
      await port.run.finish({
        runId: wrkfRunId,
        status: 'completed',
        ...(participantOutput.summary !== undefined ? { summary: participantOutput.summary } : {}),
      })
    } catch (error) {
      await port.run.fail({ runId: wrkfRunId, summary: errorMessage(error) })
      return resultFor(input.taskId, turnsCompleted, errorMessage(error), 'failed', latestNext)
    }

    turnsCompleted++

    const fresh = latestNext ?? (await readNext(port, input.taskId, 'agent'))
    latestNext = fresh
    const evidenceTimeline = await readEvidenceTimeline(port, input.taskId)
    const chosen = await choosePbcTransition({
      next: fresh,
      actor: input.actor,
      role: 'agent',
      ...(input.alternateActor !== undefined ? { alternateActor: input.alternateActor } : {}),
      ...(input.pressureActor !== undefined ? { reviewerActor: input.pressureActor } : {}),
      candidateTransitions: transitionNames(fresh),
      evidenceTimeline,
    })

    if (chosen === undefined) {
      return resultFor(input.taskId, turnsCompleted, 'blocked_or_ambiguous', 'succeeded', fresh)
    }
    if (typeof chosen === 'object' && 'blocked' in chosen) {
      return resultFor(input.taskId, turnsCompleted, chosen.reason, 'succeeded', fresh)
    }

    const transition = typeof chosen === 'string' ? chosen : chosen.transition
    const transitionActor = typeof chosen === 'string' ? input.actor : (chosen.actor ?? input.actor)
    await port.transition.apply({
      task: input.taskId,
      transition,
      role: 'agent',
      actor: transitionActor,
      expectRevision: fresh.instance.revision,
      contextHash: fresh.instance.contextHash ?? '',
      idempotencyKey: `${input.idempotencyKey}:transition:${transition}:${fresh.instance.revision}`,
      runChecks: false,
    })

    await deliverWrkfEffects(port, { task: input.taskId })

    const afterTransition = await readNext(port, input.taskId, 'agent')
    latestNext = afterTransition
  }

  return resultFor(input.taskId, turnsCompleted, 'max_turns', 'succeeded', latestNext)
}

function participantFor(
  input: PbcContinuationWorkerInput,
  next: NextActionResponse
): { role: string; actor: string } {
  const explicitRole = next.actions.find((action) => action.role !== undefined)?.role
  if (explicitRole !== undefined) {
    return {
      role: explicitRole,
      actor:
        explicitRole === 'pressure_reviewer' ? (input.pressureActor ?? input.actor) : input.actor,
    }
  }
  if (next.instance.state.phase === 'pbc_draft') {
    return { role: 'pressure_reviewer', actor: input.pressureActor ?? input.actor }
  }
  return { role: 'agent', actor: input.actor }
}

function compileWorkerPrompt(
  taskId: string,
  role: string,
  actor: string,
  next: NextActionResponse
): string {
  const actions = transitionNames(next).join(', ') || '(none)'
  return [
    '# PBC continuation turn',
    '',
    `Task: ${taskId}`,
    `Role: ${role}`,
    `Actor: ${actor}`,
    `Workflow state: ${next.instance.state.status}/${next.instance.state.phase}`,
    `Candidate transitions: ${actions}`,
    '',
    'Return exactly one ParticipantOutput JSON object.',
  ].join('\n')
}

async function readNext(
  port: PbcContinuationWorkerPort,
  taskId: string,
  role?: string
): Promise<NextActionResponse> {
  return projectNextActionResponse(
    await port.next({ task: taskId, ...(role !== undefined ? { role } : {}) })
  )
}

async function readEvidenceTimeline(
  port: PbcContinuationWorkerPort,
  taskId: string
): Promise<EvidenceRecord[]> {
  if (port.evidence.list === undefined) {
    return []
  }
  const raw = await port.evidence.list({ task: taskId })
  if (!Array.isArray(raw)) {
    return []
  }
  return raw.map((entry, index) => projectEvidenceRecord(entry, `evidenceTimeline[${index}]`))
}

function transitionNames(next: NextActionResponse): string[] {
  return next.actions
    .map((action) => action.transition)
    .filter((transition): transition is string => typeof transition === 'string')
}

function resultFor(
  taskId: string,
  turnsCompleted: number,
  stopReason: string,
  finalStatus: PbcContinuationWorkerFinalStatus,
  next?: NextActionResponse
): PbcContinuationWorkerResult {
  return {
    taskId,
    turnsCompleted,
    stopReason,
    finalStatus,
    ...(next !== undefined ? { finalRevision: next.instance.revision } : {}),
  }
}

async function persistJobResult(
  port: PbcContinuationWorkerPort,
  input: PbcContinuationWorkerInput,
  result: PbcContinuationWorkerResult
): Promise<void> {
  if (input.jobId === undefined || port.jobs?.transition === undefined) {
    return
  }
  await port.jobs.transition({
    jobId: input.jobId,
    toStatus: result.finalStatus,
    resultJson: result,
    stopReason: result.stopReason,
    ...(result.finalStatus === 'failed' ? { errorJson: { stopReason: result.stopReason } } : {}),
  })
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
