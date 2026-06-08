import type { RouteHandler } from '../routing/route-context.js'
import { approveTransition } from '../wrkf/pbc-harness.js'

import {
  requirePbcHarnessPort,
  requirePbcTaskParam,
  withPbcRouteIdempotency,
} from './wrkf-pbc-shared.js'

export const handleWrkfPbcApproveTransition: RouteHandler = (context) => {
  const task = requirePbcTaskParam(context.params)
  const wrkf = requirePbcHarnessPort(context.deps)

  return withPbcRouteIdempotency(
    context,
    `POST /v1/wrkf/pbc/tasks/${task}/approve-transition`,
    (body, idempotencyKey) =>
      approveTransition(wrkf, {
        task,
        ...body,
        routeKey: idempotencyKey,
      } as Parameters<typeof approveTransition>[1])
  )
}
