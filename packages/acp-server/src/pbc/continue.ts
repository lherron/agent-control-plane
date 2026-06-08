/**
 * POST /v1/pbc/tasks/:taskId/continue — admit/replay a durable continuation job.
 *
 * This route does NO inline HRC work (it never calls run.start). It only admits
 * (or replays, via the job store's composite-key dedup) a durable continuation
 * job and returns the projection. The PBC continuation worker (Phase 4b) is what
 * actually drives HRC turns out-of-band.
 *
 * Dedup is by (taskId, revisionAtAdmission, idempotencyKey): the same revision +
 * key returns the identical job. A waiting/terminal instance admits no job.
 */

import { json } from '../http.js'
import { parseJsonBody, requireRecord, requireTrimmedStringField } from '../parsers/body.js'
import type { RouteHandler } from '../routing/route-context.js'

import { buildPbcTaskProjection } from './projection.js'
import {
  admitPbcContinuationJob,
  deliverPbcEffects,
  isAdmissibleForContinuation,
  mapPbcRouteError,
  readPbcEvidence,
  readPbcNext,
  requirePbcStateStore,
  requirePbcTaskId,
  requirePbcWrkf,
} from './shared.js'

export const handlePbcContinue: RouteHandler = async (context) => {
  const taskId = requirePbcTaskId(context.params)
  const wrkf = requirePbcWrkf(context.deps)
  const stateStore = requirePbcStateStore(context.deps)

  const body = requireRecord(await parseJsonBody(context.request))
  const idempotencyKey = requireTrimmedStringField(body, 'idempotencyKey')

  try {
    const next = await readPbcNext(wrkf, taskId)
    await deliverPbcEffects(wrkf, taskId)

    const job = isAdmissibleForContinuation(next)
      ? admitPbcContinuationJob(stateStore, {
          taskId,
          revision: next.instance.revision,
          idempotencyKey,
        })
      : undefined

    const evidence = await readPbcEvidence(wrkf, taskId)
    return json(buildPbcTaskProjection({ taskId, next, job, evidence }), 200)
  } catch (error) {
    throw mapPbcRouteError(error)
  }
}
