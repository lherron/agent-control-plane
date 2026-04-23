import type { LaneRef } from 'agent-scope'

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
 *   { source?: string, note?: string, scopeRef?: string, laneRef?: string }
 *
 * When scopeRef is provided, it is persisted as the agent's explicit wake target.
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
  const scopeRef = readOptionalTrimmedStringField(body, 'scopeRef')
  const laneRef = readOptionalTrimmedStringField(body, 'laneRef')

  const heartbeat = deps.adminStore.heartbeats.upsert({
    agentId,
    ...(source !== undefined ? { source } : {}),
    ...(note !== undefined ? { note } : {}),
    ...(scopeRef !== undefined ? { scopeRef } : {}),
    ...(laneRef !== undefined ? { laneRef } : {}),
    now: new Date().toISOString(),
  })

  return json({ heartbeat })
}

/**
 * Extract the project ID segment from a scopeRef string.
 * Expected format: `agent:<agentId>:project:<projectId>[:...]`
 */
function extractProjectIdFromScopeRef(scopeRef: string): string | undefined {
  const parts = scopeRef.split(':')
  const projectIndex = parts.indexOf('project')
  if (projectIndex !== -1 && projectIndex + 1 < parts.length) {
    return parts[projectIndex + 1]
  }
  return undefined
}

/**
 * POST /v1/admin/agents/:agentId/heartbeat/wake
 *
 * Triggers a wake request for the given agent via the coordination substrate.
 * Uses the persisted heartbeat target (scopeRef/laneRef) or an explicit
 * override from the request body. Rejects when neither exists — does NOT
 * guess from project membership.
 *
 * Returns 202 Accepted with the wake result.
 */
export const handlePostHeartbeatWake: RouteHandler = async ({ request, params, deps }) => {
  const agentId = requireAgentId(params)

  const agent = deps.adminStore.agents.get(agentId)
  if (agent === undefined) {
    notFound('agent not found', { agentId })
  }

  if (deps.coordStore === undefined) {
    badRequest('coordination store is not available')
  }

  const body = requireRecord(await parseJsonBody(request))

  // Accept explicit target override from body
  const overrideScopeRef = readOptionalTrimmedStringField(body, 'scopeRef')
  const overrideLaneRef = readOptionalTrimmedStringField(body, 'laneRef')

  // Look up persisted target from heartbeat record
  const heartbeat = deps.adminStore.heartbeats.get(agentId)
  const persistedScopeRef = heartbeat?.targetScopeRef
  const persistedLaneRef = heartbeat?.targetLaneRef

  // Resolve effective target: override > persisted. No fallback to membership.
  const scopeRef = overrideScopeRef ?? persistedScopeRef
  const laneRef = overrideLaneRef ?? persistedLaneRef ?? 'main'

  if (scopeRef === undefined) {
    badRequest(
      'no explicit wake target: set a target via heartbeat scopeRef or provide an override in the wake request',
      { agentId }
    )
  }

  // Extract projectId from scopeRef for coordination event routing
  const targetProjectId = extractProjectIdFromScopeRef(scopeRef)
  if (targetProjectId === undefined) {
    badRequest('could not extract projectId from scopeRef', { scopeRef })
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
      sessionRef: { scopeRef, laneRef: laneRef as LaneRef },
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
