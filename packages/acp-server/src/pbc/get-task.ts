/**
 * GET /v1/pbc/tasks/:taskId — read-only PbcTaskProjection (Phase 3).
 *
 * Safe for Taskboard to render directly. Read-only: NOT wrapped with authz.
 * Surfaces an active continuation job when one exists.
 */

import { isRecord } from '../parsers/body.js'
import type { RouteHandler } from '../routing/route-context.js'
import type { AcpStateStore, PbcContinuationJob } from 'acp-state-store'

import { buildPbcTaskProjection } from './projection.js'
import {
  mapPbcRouteError,
  readPbcEvidence,
  readPbcNext,
  requirePbcTaskId,
  requirePbcWrkf,
} from './shared.js'

function findActiveJob(
  stateStore: AcpStateStore | undefined,
  taskId: string
): PbcContinuationJob | undefined {
  if (stateStore === undefined) {
    return undefined
  }
  const active = [
    ...stateStore.pbcContinuationJobs.listByStatus('running'),
    ...stateStore.pbcContinuationJobs.listByStatus('queued'),
  ].filter((job) => job.taskId === taskId)
  return active[active.length - 1]
}

/**
 * Latest terminal-FAILED job for the task, surfaced only when nothing is
 * running/queued so fresh page loads can tell "a run failed" from "no run in
 * progress" (T-04045). Succeeded/cancelled jobs are not interesting here.
 */
function findLastFailedJob(
  stateStore: AcpStateStore | undefined,
  taskId: string
): PbcContinuationJob | undefined {
  if (stateStore === undefined) {
    return undefined
  }
  const latest = stateStore.pbcContinuationJobs.latestForTask(taskId)
  return latest?.status === 'failed' ? latest : undefined
}

export const handlePbcGetTask: RouteHandler = async (context) => {
  const taskId = requirePbcTaskId(context.params)
  const wrkf = requirePbcWrkf(context.deps)

  try {
    const inspected = await wrkf.task.inspect({ task: taskId })
    const next = await readPbcNext(wrkf, taskId)
    const evidence = await readPbcEvidence(wrkf, taskId)
    const taskMeta = isRecord(inspected) ? inspected['task'] : undefined
    const job = findActiveJob(context.deps.stateStore, taskId)
    const lastJob = job === undefined ? findLastFailedJob(context.deps.stateStore, taskId) : undefined
    return Response.json(
      buildPbcTaskProjection({ taskId, next, task: taskMeta, job, lastJob, evidence }),
      { status: 200 }
    )
  } catch (error) {
    throw mapPbcRouteError(error)
  }
}
