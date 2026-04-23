import { parseActorFromHeaders } from 'acp-core'

import { badRequest, forbidden } from '../http.js'

import type { RouteContext, RouteHandler } from '../routing/route-context.js'

type AuthzResource = {
  kind: string
  id?: string | undefined
}

type ResourceResolver = (input: {
  params: RouteContext['params']
  url: URL
  body: unknown
}) => AuthzResource

export type ActorAndAuthzSpec = {
  operation: string
  resource: AuthzResource | ResourceResolver
}

async function readMaybeJsonBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get('content-type')
  if (contentType === null || !contentType.toLowerCase().includes('application/json')) {
    return undefined
  }

  const clone = request.clone()
  const text = await clone.text()
  if (text.trim().length === 0) {
    return undefined
  }

  try {
    return JSON.parse(text) as unknown
  } catch {
    badRequest('request body must be valid JSON')
  }
}

function resolveResource(
  spec: ActorAndAuthzSpec,
  context: RouteContext,
  body: unknown
): AuthzResource {
  return typeof spec.resource === 'function'
    ? spec.resource({ params: context.params, url: context.url, body })
    : spec.resource
}

export function withActorAndAuthz(spec: ActorAndAuthzSpec, handler: RouteHandler): RouteHandler {
  return async (context) => {
    const body = await readMaybeJsonBody(context.request)
    const actor = parseActorFromHeaders(context.request.headers, body, context.deps.defaultActor)
    if (actor === undefined) {
      throw new Error(`default actor resolution failed for ${spec.operation}`)
    }

    const resource = resolveResource(spec, context, body)
    if (context.deps.authorize(actor, spec.operation, resource) === 'deny') {
      forbidden('authz_deny', 'forbidden')
    }

    return handler({
      ...context,
      actor,
    })
  }
}
