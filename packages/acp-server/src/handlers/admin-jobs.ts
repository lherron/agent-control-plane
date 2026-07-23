import {
  type JobFlowValidationError,
  type JobRecord,
  isValidCron,
  isValidJobSlug,
  mapJobRunStatusForFlowResponse,
  validateJobFlow,
  validateJobFlowJob,
} from 'acp-jobs-store'
import { resolveDatabasePath } from 'hrc-core'

import { AcpHttpError, badRequest, json, notFound } from '../http.js'
import {
  isRecord,
  parseJsonBody,
  readOptionalBooleanField,
  readOptionalRecordField,
  readOptionalTrimmedStringField,
  requireRecord,
  requireTrimmedStringField,
} from '../parsers/body.js'
import { handleCreateInput } from './inputs.js'

import { validateJobTrigger } from 'acp-core'

import type { Actor, JobFlow, JobTrigger } from 'acp-core'
import type { ResolvedAcpServerDeps } from '../deps.js'
import { advanceJobFlow } from '../jobs/flow-engine.js'
import { validateJobOutputConfig } from '../jobs/job-output-config.js'
import { createJobLifecycleEmitter } from '../jobs/lifecycle-events.js'
import { resolveInterfaceSourceForScope } from '../jobs/resolve-interface-source.js'
import { getRunFinalAssistantText } from '../jobs/run-final-output.js'
import type { RouteHandler } from '../routing/route-context.js'

const MANUAL_FLOW_JOB_RUN_LEASE_MS = 30 * 60_000

function requireJobsStore(deps: ResolvedAcpServerDeps) {
  if (deps.jobsStore === undefined) {
    throw new Error('jobs store is not configured')
  }

  return deps.jobsStore
}

function resolveHrcDbPath(deps: ResolvedAcpServerDeps): string {
  const configured = (deps as ResolvedAcpServerDeps & { hrcDbPath?: string }).hrcDbPath
  return configured ?? resolveDatabasePath()
}

function requireJobId(params: Record<string, string>): string {
  const jobId = params['jobId']
  if (jobId === undefined || jobId.trim().length === 0) {
    throw new Error('jobId route param is required')
  }

  return jobId.trim()
}

function parseSchedule(
  input: Record<string, unknown>
): Readonly<Record<string, unknown>> & { cron: string } {
  const schedule = requireRecord(input['schedule'], 'schedule')
  const cron = requireTrimmedStringField(schedule, 'cron')
  if (!isValidCron(cron)) {
    throw new Error(`invalid cron schedule: ${cron}`)
  }

  return { ...schedule, cron }
}

function parseOptionalSchedule(
  input: Record<string, unknown>
): (Readonly<Record<string, unknown>> & { cron: string }) | undefined {
  const schedule = readOptionalRecordField(input, 'schedule')
  return schedule === undefined ? undefined : parseSchedule(input)
}

function parseInputTemplate(input: Record<string, unknown>): Readonly<Record<string, unknown>> {
  return requireRecord(input['input'], 'input')
}

/** Parse + validate the optional `trigger` union from a job body. */
function parseOptionalTrigger(body: Record<string, unknown>): JobTrigger | undefined {
  if (!hasOwnField(body, 'trigger')) {
    return undefined
  }
  const result = validateJobTrigger(body['trigger'])
  if (!result.valid) {
    badRequest(`invalid trigger: ${result.errors.join('; ')}`, { field: 'trigger' })
  }
  return result.trigger
}

function parseOptionalInputTemplate(
  input: Record<string, unknown>
): Readonly<Record<string, unknown>> | undefined {
  return readOptionalRecordField(input, 'input')
}

function parseOptionalOutput(input: Record<string, unknown>) {
  if (!hasOwnField(input, 'output')) {
    return undefined
  }
  if (input['output'] === null) {
    return null
  }
  const validation = validateJobOutputConfig(input['output'])
  if (!validation.valid) {
    badRequest(`invalid output: ${validation.errors.join('; ')}`, { field: 'output' })
  }
  return validation.output
}

type InvalidJobFlowValidation = { valid: false; errors: JobFlowValidationError[] }

function hasOwnField(input: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(input, field)
}

function isInvalidJobFlowValidation(input: unknown): input is InvalidJobFlowValidation {
  return isRecord(input) && input['valid'] === false && Array.isArray(input['errors'])
}

function validateFlowInput(flow: unknown): JobFlow | InvalidJobFlowValidation {
  const result = validateJobFlow(flow, { allowInputFile: false })
  return result.valid ? (flow as JobFlow) : result
}

function parseOptionalFlow(
  input: Record<string, unknown>
): JobFlow | InvalidJobFlowValidation | undefined {
  return hasOwnField(input, 'flow') ? validateFlowInput(input['flow']) : undefined
}

function readValidationSchedule(input: Record<string, unknown>) {
  const schedule = input['schedule']
  if (schedule === undefined) {
    return undefined
  }

  if (!isRecord(schedule)) {
    return { cron: '' }
  }

  const cron = schedule['cron']
  return { ...schedule, cron: typeof cron === 'string' ? cron : '' }
}

function requireJob(deps: ResolvedAcpServerDeps, jobId: string): JobRecord {
  const job = requireJobsStore(deps).getJob(jobId).job
  if (job === undefined) {
    notFound(`job not found: ${jobId}`, { jobId })
  }

  return job
}

export async function dispatchJobRunThroughInputs(
  deps: ResolvedAcpServerDeps,
  input: {
    jobId: string
    jobRunId: string
    scopeRef: string
    laneRef: string
    content: string
    causationRef?: string | undefined
    actor?: Actor | undefined
  }
): Promise<{ inputAttemptId: string; runId: string }> {
  const actor = input.actor ?? deps.defaultActor
  const interfaceSource = resolveInterfaceSourceForScope(deps, {
    scopeRef: input.scopeRef,
    laneRef: input.laneRef,
    messageRef: `jobrun:${input.jobRunId}`,
  })
  const url = new URL('http://acp.local/v1/inputs')
  const response = await handleCreateInput({
    request: new Request(url.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionRef: {
          scopeRef: input.scopeRef,
          laneRef: input.laneRef,
        },
        idempotencyKey: input.jobRunId,
        content: input.content,
        meta: {
          source: {
            kind: 'job',
            jobId: input.jobId,
            jobRunId: input.jobRunId,
            // Duplicates jobRunId intentionally: queued input dispatch can
            // reconstruct launch env from run metadata without joining jobs.
            ...(input.causationRef !== undefined ? { causationRef: input.causationRef } : {}),
          },
          ...(interfaceSource !== undefined ? { interfaceSource } : {}),
        },
      }),
    }),
    url,
    params: {},
    deps,
    actor,
  })

  if (!response.ok) {
    throw new Error(`inputs dispatch failed with ${response.status}`)
  }

  const payload = (await response.json()) as {
    inputAttempt: { inputAttemptId: string }
    run: { runId: string }
  }

  return {
    inputAttemptId: payload.inputAttempt.inputAttemptId,
    runId: payload.run.runId,
  }
}

export const handleCreateAdminJob: RouteHandler = async ({ request, deps, actor }) => {
  const body = requireRecord(await parseJsonBody(request))
  const flow = parseOptionalFlow(body)
  if (isInvalidJobFlowValidation(flow)) {
    return json(flow, 400)
  }

  const laneRef = readOptionalTrimmedStringField(body, 'laneRef')
  const disabled = readOptionalBooleanField(body, 'disabled')
  const slug = readOptionalTrimmedStringField(body, 'slug')
  if (slug !== undefined && !isValidJobSlug(slug)) {
    badRequest(`invalid slug: ${slug}`, { field: 'slug' })
  }
  const description = readOptionalTrimmedStringField(body, 'description')
  const trigger = parseOptionalTrigger(body)
  const schedule = trigger === undefined ? parseSchedule(body) : undefined
  const output = parseOptionalOutput(body)
  if (output !== undefined && output !== null && flow !== undefined) {
    badRequest('job output is only supported for non-flow jobs', { field: 'output' })
  }
  if (flow !== undefined) {
    const validation = validateJobFlowJob({
      triggerKind: trigger?.kind ?? 'schedule',
      schedule,
      flow,
    })
    if (!validation.valid) {
      return json(validation, 400)
    }
  }
  const jobsStore = requireJobsStore(deps)
  const created = jobsStore.createJob({
    agentId: requireTrimmedStringField(body, 'agentId'),
    projectId: requireTrimmedStringField(body, 'projectId'),
    scopeRef: requireTrimmedStringField(body, 'scopeRef'),
    ...(slug !== undefined ? { slug } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(laneRef !== undefined ? { laneRef } : {}),
    ...(trigger !== undefined ? { trigger } : { schedule }),
    input: parseInputTemplate(body),
    ...(output !== undefined && output !== null ? { output } : {}),
    ...(flow !== undefined ? { flow } : {}),
    ...(disabled !== undefined ? { disabled } : {}),
    actor: actor ?? deps.defaultActor,
  })

  return json(created, 201)
}

export const handleValidateAdminJob: RouteHandler = async ({ request }) => {
  const body = requireRecord(await parseJsonBody(request))
  return json(
    validateJobFlowJob({
      schedule: readValidationSchedule(body),
      flow: body['flow'],
    })
  )
}

export const handleListAdminJobs: RouteHandler = ({ url, deps }) => {
  return json(
    requireJobsStore(deps).listJobs({
      ...(url.searchParams.get('projectId')?.trim()
        ? { projectId: url.searchParams.get('projectId')?.trim() }
        : {}),
    })
  )
}

export const handleGetAdminJob: RouteHandler = ({ params, deps }) => {
  return json({ job: requireJob(deps, requireJobId(params)) })
}

export const handlePatchAdminJob: RouteHandler = async ({ request, params, deps, actor }) => {
  const body = requireRecord(await parseJsonBody(request))
  const flow = parseOptionalFlow(body)
  if (isInvalidJobFlowValidation(flow)) {
    return json(flow, 400)
  }

  const schedule = parseOptionalSchedule(body)
  const trigger = parseOptionalTrigger(body)
  const input = parseOptionalInputTemplate(body)
  const output = parseOptionalOutput(body)
  const disabled = readOptionalBooleanField(body, 'disabled')
  const slug = readOptionalTrimmedStringField(body, 'slug')
  if (slug !== undefined && !isValidJobSlug(slug)) {
    badRequest(`invalid slug: ${slug}`, { field: 'slug' })
  }
  // description may be explicitly cleared with null in the JSON body
  const descriptionPatch: { description?: string | null } =
    'description' in body
      ? body['description'] === null
        ? { description: null }
        : { description: readOptionalTrimmedStringField(body, 'description') ?? null }
      : {}
  const jobId = requireJobId(params)
  const existing = requireJob(deps, jobId)
  if (output !== undefined && output !== null) {
    const effectiveHasFlow = flow !== undefined || existing.flow !== undefined
    if (effectiveHasFlow) {
      badRequest('job output is only supported for non-flow jobs', { field: 'output' })
    }
  }
  const effectiveFlow = flow ?? existing.flow
  if (effectiveFlow !== undefined) {
    const effectiveTriggerKind =
      trigger?.kind ?? (schedule !== undefined ? 'schedule' : existing.trigger.kind)
    const validation = validateJobFlowJob({
      triggerKind: effectiveTriggerKind,
      schedule: effectiveTriggerKind === 'schedule' ? (schedule ?? existing.schedule) : undefined,
      flow: effectiveFlow,
    })
    if (!validation.valid) {
      return json(validation, 400)
    }
  }
  const updated = requireJobsStore(deps).updateJob(jobId, {
    ...(slug !== undefined ? { slug } : {}),
    ...descriptionPatch,
    ...(trigger !== undefined ? { trigger } : {}),
    ...(schedule !== undefined ? { schedule } : {}),
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(flow !== undefined ? { flow } : {}),
    ...(disabled !== undefined ? { disabled } : {}),
    actor: actor ?? deps.defaultActor,
  })

  return json(updated)
}

export const handleRunAdminJob: RouteHandler = async ({ params, deps, actor }) => {
  const jobsStore = requireJobsStore(deps)
  const job = requireJob(deps, requireJobId(params))
  const identityAuthority = deps.jobNodeIdentityAuthority
  if (identityAuthority !== undefined) {
    const verification = await identityAuthority.verifyFresh('manual_run')
    if (!verification.ok) {
      throw new AcpHttpError(409, verification.code, verification.message, {
        jobId: job.jobId,
        identity: identityAuthority.getDiagnostics(),
      })
    }
  }
  const lifecycle = createJobLifecycleEmitter({
    systemEvents: deps.adminStore.systemEvents,
    jobsStore,
    resolveFinalText: (runId) =>
      getRunFinalAssistantText(
        {
          getRun: (id) => deps.runStore.getRun(id),
          hrcDbPath: resolveHrcDbPath(deps),
        },
        runId
      ),
  })

  if (job.flow !== undefined) {
    const now = new Date().toISOString()
    const runActor = actor ?? deps.defaultActor
    const leaseExpiresAt = new Date(Date.parse(now) + MANUAL_FLOW_JOB_RUN_LEASE_MS).toISOString()
    const created = jobsStore.createJobRun(job.jobId, {
      triggeredAt: now,
      triggeredBy: 'manual',
      status: 'claimed',
      claimedAt: now,
      leaseOwner: `manual-job-run:${runActor.kind}:${runActor.id}`,
      leaseExpiresAt,
      actor: runActor,
    })
    const advanced = await advanceJobFlow({
      deps,
      job,
      jobRun: created.jobRun,
      actor: runActor,
      now,
    })
    // Project lifecycle telemetry from the committed flow result (handles a
    // synchronous flow that returns terminal — emits both start and completion).
    lifecycle.reconcile(advanced, job)
    const steps = jobsStore.jobStepRuns.listByJobRun(created.jobRun.jobRunId).jobStepRuns

    return json(
      {
        jobRun: {
          ...advanced,
          status: mapJobRunStatusForFlowResponse(advanced),
        },
        steps,
      },
      202
    )
  }

  const content = job.input['content']
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new Error(`job input.content must be a non-empty string for ${job.jobId}`)
  }

  const created = jobsStore.createJobRun(job.jobId, {
    triggeredAt: new Date().toISOString(),
    triggeredBy: 'manual',
    status: 'claimed',
    claimedAt: new Date().toISOString(),
    actor: actor ?? deps.defaultActor,
  })
  const dispatch = await dispatchJobRunThroughInputs(deps, {
    jobId: job.jobId,
    jobRunId: created.jobRun.jobRunId,
    scopeRef: job.scopeRef,
    laneRef: job.laneRef,
    content: content.trim(),
    actor: actor ?? deps.defaultActor,
  })

  const updated = jobsStore.updateJobRun(created.jobRun.jobRunId, {
    status: 'dispatched',
    inputAttemptId: dispatch.inputAttemptId,
    runId: dispatch.runId,
    dispatchedAt: new Date().toISOString(),
    leaseOwner: null,
    leaseExpiresAt: null,
    actor: actor ?? deps.defaultActor,
  })
  lifecycle.reconcile(updated.jobRun, job)

  return json(updated, 202)
}
