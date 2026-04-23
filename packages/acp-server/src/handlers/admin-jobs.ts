import { type JobRecord, isValidCron } from 'acp-jobs-store'

import { json, notFound } from '../http.js'
import {
  parseJsonBody,
  readOptionalBooleanField,
  readOptionalRecordField,
  readOptionalTrimmedStringField,
  requireRecord,
  requireTrimmedStringField,
} from '../parsers/body.js'
import { handleCreateInput } from './inputs.js'

import type { Actor } from 'acp-core'
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
  const jobsStore = requireJobsStore(deps)
  const created = jobsStore.createJob({
    agentId: requireTrimmedStringField(body, 'agentId'),
    projectId: requireTrimmedStringField(body, 'projectId'),
    scopeRef: requireTrimmedStringField(body, 'scopeRef'),
    ...(readOptionalTrimmedStringField(body, 'laneRef') !== undefined
      ? { laneRef: readOptionalTrimmedStringField(body, 'laneRef') }
      : {}),
    schedule: parseSchedule(body),
    input: parseInputTemplate(body),
    ...(readOptionalBooleanField(body, 'disabled') !== undefined
      ? { disabled: readOptionalBooleanField(body, 'disabled') }
      : {}),
    actor: actor ?? deps.defaultActor,
  })

  return json(created, 201)
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
  const updated = requireJobsStore(deps).updateJob(requireJobId(params), {
    ...(parseOptionalSchedule(body) !== undefined ? { schedule: parseOptionalSchedule(body) } : {}),
    ...(parseOptionalInputTemplate(body) !== undefined
      ? { input: parseOptionalInputTemplate(body) }
      : {}),
    ...(readOptionalBooleanField(body, 'disabled') !== undefined
      ? { disabled: readOptionalBooleanField(body, 'disabled') }
      : {}),
    actor: actor ?? deps.defaultActor,
  })

  return json(updated)
}

export const handleRunAdminJob: RouteHandler = async ({ params, deps, actor }) => {
  const jobsStore = requireJobsStore(deps)
  const job = requireJob(deps, requireJobId(params))
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
