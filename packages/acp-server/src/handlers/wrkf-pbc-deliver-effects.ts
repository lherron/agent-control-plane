import { json } from '../http.js'
import { parseJsonBody, readOptionalTrimmedStringField, requireRecord } from '../parsers/body.js'
import type { RouteHandler } from '../routing/route-context.js'
import { deliverPbcEffects } from '../wrkf/effect-delivery.js'

import { mapPbcRouteError, requireWrkf } from './wrkf-pbc-shared.js'

export const handleWrkfPbcDeliverEffects: RouteHandler = async ({ request, deps }) => {
  const wrkf = requireWrkf(deps)
  const body = requireRecord(await parseJsonBody(request))
  const task = readOptionalTrimmedStringField(body, 'task')
  const adapter = readOptionalTrimmedStringField(body, 'adapter')
  const maxEffects = body['maxEffects']

  try {
    const result = await deliverPbcEffects(wrkf, {
      task: task ?? '',
      ...(adapter !== undefined ? { adapter } : {}),
      ...(typeof maxEffects === 'number' ? { maxEffects } : {}),
    })
    return json({
      ...(task !== undefined ? { task } : {}),
      ...result,
    })
  } catch (error) {
    throw mapPbcRouteError(error)
  }
}
