import { deliverWrkfEffects } from '../wrkf/effect-delivery.js'
import { parsePbcParticipantOutput } from '../wrkf/packs/pbc/output-parser.js'
import {
  PARTICIPANT_OUTPUT_SCHEMA,
  compilePbcPrompt,
} from '../wrkf/packs/pbc/prompt-compiler.js'
import { projectPbcTemplateModelFromWorkflowShow } from '../wrkf/packs/pbc/template-model.js'
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
const DEFAULT_OUTPUT_TIMEOUT_MS = 5 * 60 * 1000
const DEFAULT_AWAITING_RECHECK_LEASE_MS = 1_000

export type PbcContinuationWorkerFinalStatus = 'succeeded' | 'failed' | 'running'

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
    renewLease?(params: {
      jobId: string
      leaseOwner: string
      leaseExpiresAt: string
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
      const waiting = await handleMissingParticipantOutput(port, input, next.instance.revision)
      if (waiting === 'awaiting') {
        return resultFor(
          input.taskId,
          turnsCompleted,
          'awaiting_participant_output',
          'running',
          next
        )
      }

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

async function handleMissingParticipantOutput(
  port: PbcContinuationWorkerPort,
  input: PbcContinuationWorkerInput,
  revision: number
): Promise<'awaiting' | 'timed_out'> {
  const captureKey = outputWaitCaptureKey(input.idempotencyKey, revision)
  const existing = await port.captures.get(captureKey)
  const nowMs = Date.now()
  const startedAtMs = readWaitStartedAtMs(existing)

  if (startedAtMs !== undefined && nowMs - startedAtMs >= readOutputTimeoutMs()) {
    return 'timed_out'
  }

  if (startedAtMs === undefined) {
    await port.captures.set(captureKey, outputWaitCaptureRecord(new Date(nowMs).toISOString()))
  }

  if (input.jobId !== undefined && port.jobs?.renewLease !== undefined) {
    const leaseMs = Math.min(input.leaseMs ?? DEFAULT_LEASE_MS, DEFAULT_AWAITING_RECHECK_LEASE_MS)
    await port.jobs.renewLease({
      jobId: input.jobId,
      leaseOwner: input.leaseOwner ?? 'pbc-continuation-worker',
      leaseExpiresAt: new Date(nowMs + leaseMs).toISOString(),
    })
  }

  return 'awaiting'
}

function outputWaitCaptureKey(idempotencyKey: string, revision: number): string {
  return `${idempotencyKey}:output-wait-started-at:${revision}`
}

function readWaitStartedAtMs(value: unknown): number | undefined {
  const evidenceStartedAt = readWaitStartedAtFromCaptureRecord(value)
  const raw =
    evidenceStartedAt !== undefined
      ? evidenceStartedAt
      : typeof value === 'string'
      ? value
      : typeof value === 'object' && value !== null
        ? readString(value as Record<string, unknown>, 'startedAt') ??
          readString(value as Record<string, unknown>, 'started_at') ??
          readString(value as Record<string, unknown>, 'value')
        : undefined
  if (raw === undefined) {
    return undefined
  }
  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) ? parsed : undefined
}

function outputWaitCaptureRecord(startedAt: string): {
  status: 'ingested'
  evidenceAdded: Array<Record<string, unknown>>
  obligationsSatisfied: []
} {
  return {
    status: 'ingested',
    evidenceAdded: [
      {
        id: `output-wait:${startedAt}`,
        kind: 'output_wait_started',
        raw: {},
        data: { startedAt },
      },
    ],
    obligationsSatisfied: [],
  }
}

function readWaitStartedAtFromCaptureRecord(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const evidenceAdded = (value as Record<string, unknown>)['evidenceAdded']
  if (!Array.isArray(evidenceAdded)) {
    return undefined
  }
  for (const evidence of evidenceAdded) {
    if (typeof evidence !== 'object' || evidence === null) {
      continue
    }
    const record = evidence as Record<string, unknown>
    const data = record['data']
    if (typeof data === 'object' && data !== null) {
      const startedAt = readString(data as Record<string, unknown>, 'startedAt')
      if (startedAt !== undefined) {
        return startedAt
      }
    }
    const id = readString(record, 'id')
    if (id?.startsWith('output-wait:') === true) {
      return id.slice('output-wait:'.length)
    }
  }
  return undefined
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function readOutputTimeoutMs(): number {
  const raw = process.env['ACP_PBC_WORKER_OUTPUT_TIMEOUT']?.trim()
  if (raw === undefined || raw.length === 0) {
    return DEFAULT_OUTPUT_TIMEOUT_MS
  }
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_OUTPUT_TIMEOUT_MS
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

/**
 * The non-negotiable output rule appended to every worker prompt. The
 * participant agents (larry/curly) are general agents that habitually wrap JSON
 * in prose or a ```json fence; the parser now tolerates a single fence, but we
 * still ask for bare JSON to keep ingestion deterministic (T-03554).
 */
const STRICT_OUTPUT_DIRECTIVE = [
  '## Output contract — STRICT',
  '',
  'Your ENTIRE response MUST be exactly one JSON object that matches the',
  'ParticipantOutput schema below. Nothing else.',
  '',
  '- Do NOT add any prose before or after the JSON.',
  '- Do NOT wrap the JSON in a markdown code fence (no ```json, no ```).',
  '- The first character of your response must be `{` and the last must be `}`.',
  '- Emit exactly ONE JSON object — never two.',
].join('\n')

function compileWorkerPrompt(
  taskId: string,
  role: string,
  actor: string,
  next: NextActionResponse
): string {
  const templatePrompt = tryCompileTemplatePrompt(taskId, role, actor, next)
  if (templatePrompt !== undefined) {
    return [templatePrompt, '', STRICT_OUTPUT_DIRECTIVE].join('\n')
  }

  // Fallback: template model not available on the `next` projection. Still
  // embed the participant-output schema + the strict directive so the agent
  // knows the exact contract.
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
    STRICT_OUTPUT_DIRECTIVE,
    '',
    '```ts',
    PARTICIPANT_OUTPUT_SCHEMA,
    '```',
  ].join('\n')
}

/**
 * Best-effort: build the full template-driven participant prompt (phase
 * guidance + per-transition evidence shape + schema) from the template model
 * carried on the `next` projection. Returns undefined when the template model
 * is absent or cannot be projected, so the caller can fall back.
 */
function tryCompileTemplatePrompt(
  taskId: string,
  role: string,
  actor: string,
  next: NextActionResponse
): string | undefined {
  const rawTemplate = next.instance.template
  if (rawTemplate === undefined) {
    return undefined
  }
  try {
    const template = projectPbcTemplateModelFromWorkflowShow({ workflow: rawTemplate })
    return compilePbcPrompt({
      template,
      task: taskId,
      role,
      actor,
      next,
      evidenceSummaries: [],
      obligations: next.openObligations,
    })
  } catch {
    return undefined
  }
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
  if (result.finalStatus === 'running') {
    return
  }
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
