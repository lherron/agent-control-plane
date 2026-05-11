import { badRequest, json, notFound } from '../http.js'

import type { RouteHandler } from '../routing/route-context.js'

function requireAgentId(params: Record<string, string>): string {
  const agentId = params['agentId']
  if (agentId === undefined || agentId.length === 0) {
    badRequest('agentId route param is required', { field: 'agentId' })
  }

  return agentId
}

export const handleGetAdminAgentHeartbeat: RouteHandler = async ({ params, deps }) => {
  const agentId = requireAgentId(params)
  const agent = deps.adminStore.agents.get(agentId)
  if (agent === undefined) {
    notFound('agent not found', { agentId })
  }

  return json({ heartbeat: deps.adminStore.heartbeats.get(agentId) ?? null })
}
