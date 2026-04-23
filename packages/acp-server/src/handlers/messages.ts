import { appendRawCoordinationMessage } from '../coordination/raw-append.js'
import { json } from '../http.js'
import { parseJsonBody, requireRecord, requireTrimmedStringField } from '../parsers/body.js'

import type { RouteHandler } from '../routing/route-context.js'

export const handleCreateMessage: RouteHandler = async ({ request, deps }) => {
  const body = requireRecord(await parseJsonBody(request))
  const result = appendRawCoordinationMessage(deps.coordStore, {
    projectId: requireTrimmedStringField(body, 'projectId'),
    ...(typeof body['idempotencyKey'] === 'string' && body['idempotencyKey'].trim().length > 0
      ? { idempotencyKey: body['idempotencyKey'].trim() }
      : {}),
    event: requireRecord(body['event'], 'event') as never,
    ...(body['handoff'] !== undefined
      ? { handoff: requireRecord(body['handoff'], 'handoff') as never }
      : {}),
    ...(body['wake'] !== undefined ? { wake: requireRecord(body['wake'], 'wake') as never } : {}),
    ...(Array.isArray(body['localRecipients'])
      ? { localRecipients: body['localRecipients'] as never }
      : {}),
  })

  return json(
    {
      event: result.event,
      ...(result.handoff !== undefined ? { handoff: result.handoff } : {}),
      ...(result.wake !== undefined ? { wake: result.wake } : {}),
    },
    201
  )
}
