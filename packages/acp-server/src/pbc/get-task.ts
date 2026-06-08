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
import { mapPbcRouteError, readPbcNext, requirePbcTaskId, requirePbcWrkf } from './shared.js'

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

export const handlePbcGetTask: RouteHandler = async (context) => {
  const taskId = requirePbcTaskId(context.params)
  const wrkf = requirePbcWrkf(context.deps)

  try {
    const inspected = await wrkf.task.inspect({ task: taskId })
    const next = await readPbcNext(wrkf, taskId)
    const taskMeta = isRecord(inspected) ? inspected['task'] : undefined
    const job = findActiveJob(context.deps.stateStore, taskId)
    return Response.json(buildPbcTaskProjection({ taskId, next, task: taskMeta, job }), {
      status: 200,
    })
  } catch (error) {
    throw mapPbcRouteError(error)
  }
}
