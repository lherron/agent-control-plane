import { parseScopeRef } from 'agent-scope'

import { json } from '../http.js'
import { extractActor } from '../parsers/actor.js'
import { parseJsonBody, requireRecord, requireTrimmedStringField } from '../parsers/body.js'
import { parseSessionRefField, readOptionalMeta } from './shared.js'

import type { RouteHandler } from '../routing/route-context.js'

export const handleCreateInput: RouteHandler = async ({ request, deps }) => {
  const body = requireRecord(await parseJsonBody(request))
  const sessionRef = parseSessionRefField(body, 'sessionRef')
  const actor = extractActor(request, body)
  const parsedScope = parseScopeRef(sessionRef.scopeRef)

  const result = deps.inputAttemptStore.createAttempt({
    sessionRef,
    ...(parsedScope.taskId !== undefined ? { taskId: parsedScope.taskId } : {}),
    ...(typeof body['idempotencyKey'] === 'string' && body['idempotencyKey'].trim().length > 0
      ? { idempotencyKey: body['idempotencyKey'].trim() }
      : {}),
    content: requireTrimmedStringField(body, 'content'),
    actor: { agentId: actor?.agentId ?? '' },
    ...(readOptionalMeta(body) !== undefined ? { metadata: readOptionalMeta(body) } : {}),
    runStore: deps.runStore,
  })

  return json({ inputAttempt: result.inputAttempt }, 201)
}
