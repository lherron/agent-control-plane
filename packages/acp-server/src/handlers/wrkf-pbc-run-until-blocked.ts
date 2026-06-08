import type { RouteHandler } from '../routing/route-context.js'
import { runUntilBlocked } from '../wrkf/pbc-harness.js'

import {
  requirePbcHarnessPort,
  requirePbcTaskParam,
  withPbcRouteIdempotency,
} from './wrkf-pbc-shared.js'

export const handleWrkfPbcRunUntilBlocked: RouteHandler = (context) => {
  const task = requirePbcTaskParam(context.params)
  const wrkf = requirePbcHarnessPort(context.deps)

  return withPbcRouteIdempotency(
    context,
    `POST /v1/wrkf/pbc/tasks/${task}/run-until-blocked`,
    (body) =>
      runUntilBlocked(wrkf, {
        task,
        ...body,
      } as Parameters<typeof runUntilBlocked>[1])
  )
}
