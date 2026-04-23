import { badRequest, json, notFound } from '../http.js'
import { parseJsonBody, readOptionalTrimmedStringField, requireRecord } from '../parsers/body.js'

import type { RouteHandler } from '../routing/route-context.js'

function requireAgentId(params: Record<string, string>): string {
  const agentId = params['agentId']
  if (agentId === undefined || agentId.length === 0) {
    badRequest('agentId route param is required', { field: 'agentId' })
  }

  return agentId
}

/**
 * PUT /v1/admin/agents/:agentId/heartbeat
 *
 * Upserts a heartbeat for the given agent. Body may include:
 *   { source?: string, note?: string }
 *
 * Returns 200 with the heartbeat record.
 */
export const handlePutHeartbeat: RouteHandler = async ({ request, params, deps }) => {
  const agentId = requireAgentId(params)

  const agent = deps.adminStore.agents.get(agentId)
  if (agent === undefined) {
    notFound('agent not found', { agentId })
  }

  const body = requireRecord(await parseJsonBody(request))
  const source = readOptionalTrimmedStringField(body, 'source')
  const note = readOptionalTrimmedStringField(body, 'note')

  const heartbeat = deps.adminStore.heartbeats.upsert({
    agentId,
    ...(source !== undefined ? { source } : {}),
    ...(note !== undefined ? { note } : {}),
    now: new Date().toISOString(),
  })

  return json({ heartbeat })
}

/**
 * POST /v1/admin/agents/:agentId/heartbeat/wake
 *
 * Triggers a wake request for the given agent via the coordination substrate.
 * Looks up the agent's default project membership and issues a wake through
 * appendEvent with a wake request attached.
 *
 * Returns 202 Accepted with the wake result.
 */
export const handlePostHeartbeatWake: RouteHandler = async ({ params, deps }) => {
  const agentId = requireAgentId(params)

  const agent = deps.adminStore.agents.get(agentId)
  if (agent === undefined) {
    notFound('agent not found', { agentId })
  }

  if (deps.coordStore === undefined) {
    badRequest('coordination store is not available')
  }

  // Find the first project where this agent has membership
  const projects = deps.adminStore.projects.list()
  let targetProjectId: string | undefined
  let scopeRef: string | undefined

  for (const project of projects) {
    const memberships = deps.adminStore.memberships.listByProject(project.projectId)
    const agentMembership = memberships.find((m) => m.agentId === agentId)
    if (agentMembership !== undefined) {
      targetProjectId = project.projectId
      scopeRef = `agent:${agentId}:project:${project.projectId}`
      break
    }
  }

  if (targetProjectId === undefined || scopeRef === undefined) {
    badRequest('agent has no project membership; cannot determine wake target', { agentId })
  }

  // Import and use appendEvent from coordination-substrate
  const { appendEvent } = await import('coordination-substrate')
  const result = appendEvent(deps.coordStore, {
    projectId: targetProjectId,
    event: {
      ts: new Date().toISOString(),
      kind: 'system.noted',
      actor: { kind: 'agent', agentId: 'acp-heartbeat' },
      content: { kind: 'json', body: JSON.stringify({ agentId, reason: 'operator-wake' }) },
      meta: { source: 'heartbeat-wake' },
    },
    wake: {
      sessionRef: { scopeRef, laneRef: 'main' },
      reason: `operator wake for ${agentId}`,
      dedupeKey: `heartbeat-wake:${agentId}`,
    },
  })

  return json(
    {
      accepted: true,
      agentId,
      projectId: targetProjectId,
      wakeId: result.wake?.wakeId,
    },
    202
  )
}
