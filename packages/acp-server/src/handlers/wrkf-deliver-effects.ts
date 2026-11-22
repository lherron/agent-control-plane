import { AcpHttpError, json } from '../http.js'
import { parseJsonBody, readOptionalTrimmedStringField, requireRecord } from '../parsers/body.js'
import type { RouteHandler } from '../routing/route-context.js'
import { deliverWrkfEffects } from '../wrkf/effect-delivery.js'
import { wrkfErrorToHttpStatus } from '../wrkf/errors.js'

export const handleWrkfDeliverEffects: RouteHandler = async ({ request, deps }) => {
  const wrkf = deps.wrkf
  if (wrkf === undefined) {
    throw new AcpHttpError(503, 'WRKF_UNAVAILABLE', 'wrkf port not available')
  }
  const body = requireRecord(await parseJsonBody(request))
  const task = readOptionalTrimmedStringField(body, 'task')
  const adapter = readOptionalTrimmedStringField(body, 'adapter')
  const maxEffects = body['maxEffects']

  try {
    const result = await deliverWrkfEffects(wrkf, {
      task: task ?? '',
      ...(adapter !== undefined ? { adapter } : {}),
      ...(typeof maxEffects === 'number' ? { maxEffects } : {}),
    })
    return json({
      ...(task !== undefined ? { task } : {}),
      ...result,
    })
  } catch (error) {
    throw mapWrkfRouteError(error)
  }
}

function mapWrkfRouteError(error: unknown): unknown {
  if (error instanceof AcpHttpError) {
    return error
  }
  const code = (error as { code?: unknown }).code
  if (error instanceof Error && typeof code === 'string' && code.length > 0) {
    return new AcpHttpError(wrkfErrorToHttpStatus(code), code, error.message)
  }
  return error
}
