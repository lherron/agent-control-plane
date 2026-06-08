/**
 * GET /v1/pbc/jobs/:jobId — durable continuation job status (Phase 3).
 *
 * Read-only view over pbc_continuation_jobs. 404 JOB_NOT_FOUND for unknown ids.
 */

import { AcpHttpError, json } from '../http.js'
import type { RouteHandler } from '../routing/route-context.js'

import { requirePbcStateStore } from './shared.js'

export const handlePbcGetJob: RouteHandler = (context) => {
  const jobId = context.params['jobId']
  if (jobId === undefined || jobId.length === 0) {
    throw new AcpHttpError(400, 'malformed_request', 'jobId route parameter is required')
  }
  const stateStore = requirePbcStateStore(context.deps)
  const job = stateStore.pbcContinuationJobs.get(jobId)
  if (job === undefined) {
    throw new AcpHttpError(404, 'JOB_NOT_FOUND', `pbc continuation job not found: ${jobId}`)
  }

  return json({
    id: job.jobId,
    taskId: job.taskId,
    workflowRef: job.workflowRef,
    status: job.status,
    attempt: job.attempt,
    revisionAtAdmission: job.revisionAtAdmission,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    ...(job.startedAt !== undefined ? { startedAt: job.startedAt } : {}),
    ...(job.finishedAt !== undefined ? { finishedAt: job.finishedAt } : {}),
    ...(job.stopReason !== undefined ? { stopReason: job.stopReason } : {}),
    ...(job.resultJson !== undefined ? { result: job.resultJson } : {}),
    ...(job.errorJson !== undefined ? { error: job.errorJson } : {}),
  })
}
