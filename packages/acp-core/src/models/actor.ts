export type Actor = {
  kind: 'human' | 'agent' | 'system'
  id: string
  displayName?: string | undefined
}

export type ActorStamp = {
  actorKind: Actor['kind']
  actorId: Actor['id']
  actorDisplayName?: Actor['displayName'] | undefined
}

export class ActorValidationError extends Error {
  readonly field: string

  constructor(field: string, message: string) {
    super(message)
    this.name = 'ActorValidationError'
    this.field = field
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function normalizeActor(actor: Actor): Actor {
  return {
    kind: actor.kind,
    id: actor.id.trim(),
    ...(actor.displayName !== undefined ? { displayName: actor.displayName } : {}),
  }
}

function validateActor(candidate: unknown, field: string): Actor {
  if (!isRecord(candidate)) {
    throw new ActorValidationError(field, `${field} must be an object`)
  }

  const legacyAgentId = candidate['agentId']
  if (typeof legacyAgentId === 'string' && legacyAgentId.trim().length > 0) {
    const legacyDisplayName = candidate['displayName']
    if (legacyDisplayName !== undefined && typeof legacyDisplayName !== 'string') {
      throw new ActorValidationError(field, `${field}.displayName must be a string`)
    }

    return {
      kind: 'agent',
      id: legacyAgentId.trim(),
      ...(typeof legacyDisplayName === 'string' ? { displayName: legacyDisplayName } : {}),
    }
  }

  const kind = candidate['kind']
  if (kind !== 'human' && kind !== 'agent' && kind !== 'system') {
    throw new ActorValidationError(field, `${field}.kind must be one of: human, agent, system`)
  }

  const id = candidate['id']
  if (typeof id !== 'string' || id.trim().length === 0) {
    throw new ActorValidationError(field, `${field}.id must be a non-empty string`)
  }

  const displayName = candidate['displayName']
  if (displayName !== undefined && typeof displayName !== 'string') {
    throw new ActorValidationError(field, `${field}.displayName must be a string`)
  }

  return {
    kind,
    id: id.trim(),
    ...(displayName !== undefined ? { displayName } : {}),
  }
}

function parseActorHeader(value: string | null): Actor | undefined {
  if (value === null || value.trim().length === 0) {
    return undefined
  }

  const trimmed = value.trim()

  if (!trimmed.startsWith('{')) {
    const separator = trimmed.indexOf(':')
    if (separator === -1) {
      throw new ActorValidationError('x-acp-actor', 'x-acp-actor must be kind:id or JSON')
    }

    const kind = trimmed.slice(0, separator).trim()
    const id = trimmed.slice(separator + 1).trim()
    return validateActor({ kind, id }, 'x-acp-actor')
  }

  try {
    const parsed = JSON.parse(value) as unknown
    return validateActor(parsed, 'x-acp-actor')
  } catch (error) {
    if (error instanceof ActorValidationError) {
      throw error
    }

    throw new ActorValidationError('x-acp-actor', 'x-acp-actor must be valid JSON')
  }
}

function parseActorFromBody(body: unknown): Actor | undefined {
  if (!isRecord(body)) {
    return undefined
  }

  const actor = body['actor']
  if (actor === undefined) {
    return undefined
  }

  return validateActor(actor, 'actor')
}

export function parseActorFromHeaders(
  headers: Headers,
  body: unknown,
  envDefault?: Actor | undefined
): Actor | undefined {
  return (
    parseActorHeader(headers.get('x-acp-actor')) ??
    parseActorHeader(
      headers.get('x-acp-actor-agent-id')?.trim()
        ? `agent:${headers.get('x-acp-actor-agent-id')?.trim()}`
        : null
    ) ??
    parseActorFromBody(body) ??
    (envDefault !== undefined ? normalizeActor(envDefault) : undefined)
  )
}
