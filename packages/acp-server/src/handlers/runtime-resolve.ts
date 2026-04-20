import { parseScopeRef } from 'agent-scope'

import { json, notFound } from '../http.js'
import { parseJsonBody, requireRecord } from '../parsers/body.js'
import { parseSessionRefField } from './shared.js'

import type { RouteHandler } from '../routing/route-context.js'

export const handleResolveRuntime: RouteHandler = async ({ request, deps }) => {
  const body = requireRecord(await parseJsonBody(request))
  const sessionRef = parseSessionRefField(body, 'sessionRef')

  const resolvedPlacement = deps.runtimeResolver
    ? await deps.runtimeResolver(sessionRef)
    : undefined
  if (resolvedPlacement !== undefined) {
    return json({ placement: resolvedPlacement })
  }

  const parsedScope = parseScopeRef(sessionRef.scopeRef)
  const agentRoot = deps.agentRootResolver
    ? await deps.agentRootResolver({ agentId: parsedScope.agentId, sessionRef })
    : undefined
  if (agentRoot === undefined) {
    notFound(`runtime placement not found for ${sessionRef.scopeRef}`, {
      scopeRef: sessionRef.scopeRef,
      laneRef: sessionRef.laneRef,
    })
  }

  return json({
    placement: {
      agentRoot,
      runMode: 'task',
      bundle: { kind: 'agent-default' },
      correlation: { sessionRef },
    },
  })
}
