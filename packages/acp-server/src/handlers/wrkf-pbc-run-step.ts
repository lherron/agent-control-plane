import type { RouteHandler } from '../routing/route-context.js'
import { runStep } from '../wrkf/pbc-harness.js'

import {
  requirePbcHarnessPort,
  requirePbcTaskParam,
  withPbcRouteIdempotency,
} from './wrkf-pbc-shared.js'

export const handleWrkfPbcRunStep: RouteHandler = (context) => {
  const task = requirePbcTaskParam(context.params)
  const wrkf = requirePbcHarnessPort(context.deps)

  return withPbcRouteIdempotency(context, `POST /v1/wrkf/pbc/tasks/${task}/run-step`, (body) =>
    runStep(wrkf, {
      task,
      ...body,
    } as Parameters<typeof runStep>[1])
  )
}
