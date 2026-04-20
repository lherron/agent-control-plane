import { badRequest } from '../http.js'
import { isRecord } from './body.js'

export type ExtractedActor = {
  agentId: string
  role?: string | undefined
}

export function extractActor(
  request: Request,
  body: unknown,
  options: { required?: boolean | undefined; requireRole?: boolean | undefined } = {}
): ExtractedActor | undefined {
  const bodyActor = isRecord(body) && isRecord(body['actor']) ? body['actor'] : undefined
  const bodyAgentId =
    bodyActor !== undefined &&
    typeof bodyActor['agentId'] === 'string' &&
    bodyActor['agentId'].trim().length > 0
      ? bodyActor['agentId'].trim()
      : undefined
  const bodyRole =
    bodyActor !== undefined &&
    typeof bodyActor['role'] === 'string' &&
    bodyActor['role'].trim().length > 0
      ? bodyActor['role'].trim()
      : undefined

  const headerAgentId = request.headers.get('x-acp-actor-agent-id')?.trim() || undefined
  const agentId = bodyAgentId ?? headerAgentId

  if (agentId === undefined) {
    if (options.required !== false) {
      badRequest('actor.agentId is required or provide x-acp-actor-agent-id', {
        field: 'actor.agentId',
      })
    }

    return undefined
  }

  if (options.requireRole === true && bodyRole === undefined) {
    badRequest('actor.role is required', { field: 'actor.role' })
  }

  return {
    agentId,
    ...(bodyRole !== undefined ? { role: bodyRole } : {}),
  }
}
