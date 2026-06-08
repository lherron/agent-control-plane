/**
 * POST /v1/pbc/tasks/:taskId/effects/reconcile — operator/debug effect drain.
 *
 * Operator-only escape hatch: lists pending wrkf effects for the task and
 * attempts delivery, returning the delivery result. Not part of the normal
 * product flow (start/input/continue handle effect delivery inline).
 */

import { deliverWrkfEffects } from '../wrkf/effect-delivery.js'
import { json } from '../http.js'
import type { RouteHandler } from '../routing/route-context.js'

import { mapPbcRouteError, requirePbcTaskId, requirePbcWrkf } from './shared.js'

export const handlePbcReconcileEffects: RouteHandler = async (context) => {
  const taskId = requirePbcTaskId(context.params)
  const wrkf = requirePbcWrkf(context.deps)

  try {
    const result = await deliverWrkfEffects(wrkf, { task: taskId })
    return json({ taskId, ...result }, 200)
  } catch (error) {
    throw mapPbcRouteError(error)
  }
}
