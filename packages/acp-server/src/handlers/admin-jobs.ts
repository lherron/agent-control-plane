import {
  type JobFlowValidationError,
  type JobRecord,
  isValidCron,
  mapJobRunStatusForFlowResponse,
  validateJobFlow,
  validateJobFlowJob,
} from 'acp-jobs-store'

import { json, notFound } from '../http.js'
import { advanceJobFlow } from '../jobs/flow-engine.js'
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

import type { Actor, JobFlow } from 'acp-core'
import type { ResolvedAcpServerDeps } from '../deps.js'
import type { RouteHandler } from '../routing/route-context.js'

function requireJobsStore(deps: ResolvedAcpServerDeps) {
  if (deps.jobsStore === undefined) {
    throw new Error('jobs store is not configured')
  }

  return deps.jobsStore
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

function parseOptionalInputTemplate(
  input: Record<string, unknown>
): Readonly<Record<string, unknown>> | undefined {
  return readOptionalRecordField(input, 'input')
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
    actor?: Actor | undefined
  }
): Promise<{ inputAttemptId: string; runId: string }> {
  const actor = input.actor ?? deps.defaultActor
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
          },
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
  const jobsStore = requireJobsStore(deps)
  const created = jobsStore.createJob({
    agentId: requireTrimmedStringField(body, 'agentId'),
    projectId: requireTrimmedStringField(body, 'projectId'),
    scopeRef: requireTrimmedStringField(body, 'scopeRef'),
    ...(laneRef !== undefined ? { laneRef } : {}),
    schedule: parseSchedule(body),
    input: parseInputTemplate(body),
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
  const input = parseOptionalInputTemplate(body)
  const disabled = readOptionalBooleanField(body, 'disabled')
  const updated = requireJobsStore(deps).updateJob(requireJobId(params), {
    ...(schedule !== undefined ? { schedule } : {}),
    ...(input !== undefined ? { input } : {}),
    ...(flow !== undefined ? { flow } : {}),
    ...(disabled !== undefined ? { disabled } : {}),
    actor: actor ?? deps.defaultActor,
  })

  return json(updated)
}

export const handleRunAdminJob: RouteHandler = async ({ params, deps, actor }) => {
  const jobsStore = requireJobsStore(deps)
  const job = requireJob(deps, requireJobId(params))

  if (job.flow !== undefined) {
    const now = new Date().toISOString()
    const created = jobsStore.createJobRun(job.jobId, {
      triggeredAt: now,
      triggeredBy: 'manual',
      status: 'claimed',
      claimedAt: now,
      actor: actor ?? deps.defaultActor,
    })
    const advanced = await advanceJobFlow({
      deps,
      job,
      jobRun: created.jobRun,
      now,
      actor: actor ?? deps.defaultActor,
    })
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

  return json(updated, 202)
}
