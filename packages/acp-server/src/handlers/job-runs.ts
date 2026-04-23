import { json, notFound } from '../http.js'

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

function requireJobRunId(params: Record<string, string>): string {
  const jobRunId = params['jobRunId']
  if (jobRunId === undefined || jobRunId.trim().length === 0) {
    throw new Error('jobRunId route param is required')
  }

  return jobRunId.trim()
}

export const handleListJobRuns: RouteHandler = ({ params, deps }) => {
  return json(requireJobsStore(deps).listJobRuns(requireJobId(params)))
}

export const handleGetJobRun: RouteHandler = ({ params, deps }) => {
  const jobRunId = requireJobRunId(params)
  const jobRun = requireJobsStore(deps).getJobRun(jobRunId).jobRun
  if (jobRun === undefined) {
    notFound(`job run not found: ${jobRunId}`, { jobRunId })
  }

  return json({ jobRun })
}
