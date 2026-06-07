import type { JobRunRecord, JobsStore } from 'acp-jobs-store'

import { badRequest, json, notFound } from '../http.js'
import { toApiInterfaceBinding } from './interface-shared.js'

import type { ResolvedAcpServerDeps } from '../deps.js'
import type { RouteHandler } from '../routing/route-context.js'
import {
  buildScheduleSummary,
  latestJobRuns,
  normalizeFlow,
  provenance,
  summarizeJob,
} from './admin-detail-shared.js'

function requireJobsStore(deps: ResolvedAcpServerDeps): JobsStore {
  if (deps.jobsStore === undefined) {
    throw new Error('jobs store is not configured')
  }

  return deps.jobsStore
}

function requireJobId(params: Record<string, string>): string {
  const jobId = params['jobId']?.trim()
  if (jobId === undefined || jobId.length === 0) {
    badRequest('jobId route param is required', { field: 'jobId' })
  }

  return jobId
}

function collectInputAttempts(deps: ResolvedAcpServerDeps, jobRuns: readonly JobRunRecord[]) {
  return jobRuns
    .map((jobRun) =>
      jobRun.inputAttemptId === undefined
        ? undefined
        : {
            jobRunId: jobRun.jobRunId,
            record: deps.inputAttemptStore.getById(jobRun.inputAttemptId),
          }
    )
    .filter((entry): entry is Exclude<typeof entry, undefined> => entry !== undefined)
}

function collectRuns(deps: ResolvedAcpServerDeps, jobRuns: readonly JobRunRecord[]) {
  return jobRuns
    .map((jobRun) =>
      jobRun.runId === undefined
        ? undefined
        : {
            jobRunId: jobRun.jobRunId,
            run: deps.runStore.getRun(jobRun.runId),
          }
    )
    .filter((entry): entry is Exclude<typeof entry, undefined> => entry !== undefined)
}

export const handleGetAdminJobDetail: RouteHandler = async ({ params, deps }) => {
  const jobsStore = requireJobsStore(deps)
  const jobId = requireJobId(params)
  const job = jobsStore.getJob(jobId).job
  if (job === undefined) {
    notFound('job not found', { jobId })
  }

  const allJobRuns = jobsStore.listJobRuns(jobId).jobRuns
  const latestRuns = latestJobRuns(allJobRuns)
  const latestStepRuns = latestRuns.flatMap((jobRun) =>
    jobsStore.jobStepRuns.listByJobRun(jobRun.jobRunId).jobStepRuns.map((stepRun) => ({
      jobRunId: jobRun.jobRunId,
      stepRun,
    }))
  )
  const project = deps.adminStore.projects.get(job.projectId)
  const agent = deps.adminStore.agents.get(job.agentId)
  const memberships = deps.adminStore.memberships.listByProject(job.projectId)
  const interfaceBindings = deps.interfaceStore.bindings
    .list({ projectId: job.projectId })
    .map(toApiInterfaceBinding)

  const schedule = buildScheduleSummary(job)
  return json({
    job,
    summary: summarizeJob(job),
    trigger: job.trigger,
    ...(schedule !== undefined ? { schedule } : {}),
    startup: {
      scopeRef: job.scopeRef,
      laneRef: job.laneRef,
      input: job.input,
      actor: job.actor,
    },
    ...(job.flow !== undefined ? { flow: normalizeFlow(job.flow) } : {}),
    latestRuns,
    provenance: [
      provenance('jobs_store.jobs', true),
      provenance('jobs_store.job_runs', true),
      provenance('jobs_store.job_step_runs', true),
      provenance('admin_store.projects', project !== undefined),
      provenance('admin_store.agents', agent !== undefined),
      provenance('admin_store.memberships', true),
      provenance('interface_store.interface_bindings', true),
      provenance('acp_state.input_attempts', true),
      provenance('acp_state.runs', true),
    ],
    lineage: {
      ...(project !== undefined ? { project } : {}),
      ...(agent !== undefined ? { agent } : {}),
      memberships,
      interfaceBindings,
      jobRuns: latestRuns,
      stepRuns: latestStepRuns,
      inputAttempts: collectInputAttempts(deps, latestRuns),
      runs: collectRuns(deps, latestRuns),
    },
  })
}
