import { badRequest, conflict, json, notFound } from '../http.js'
import {
  parseJsonBody,
  readOptionalTrimmedStringField,
  requireRecord,
  requireTrimmedStringField,
} from '../parsers/body.js'

import type { RouteContext, RouteHandler } from '../routing/route-context.js'

function requireActor(context: RouteContext) {
  const actor = context.actor
  if (actor === undefined) {
    badRequest('actor is required', { field: 'actor' })
  }

  return actor
}

function parseAgentStatus(value: unknown): 'active' | 'disabled' {
  if (value !== 'active' && value !== 'disabled') {
    badRequest('status must be one of: active, disabled', { field: 'status' })
  }

  return value
}

function requireAgentId(params: Record<string, string>): string {
  const agentId = params['agentId']
  if (agentId === undefined || agentId.length === 0) {
    badRequest('agentId route param is required', { field: 'agentId' })
  }

  return agentId
}

export const handleCreateAdminAgent: RouteHandler = async (context) => {
  const { request, deps } = context
  const body = requireRecord(await parseJsonBody(request))
  const agentId = requireTrimmedStringField(body, 'agentId')
  const displayName = readOptionalTrimmedStringField(body, 'displayName')
  const homeDir = readOptionalTrimmedStringField(body, 'homeDir')
  const status = parseAgentStatus(body['status'])
  const actor = requireActor(context)
  const existing = deps.adminStore.agents.get(agentId)

  if (existing !== undefined) {
    if ((existing.displayName ?? undefined) === displayName && existing.status === status) {
      return json({ agent: existing }, 200)
    }

    conflict('agent already exists', { agentId })
  }

  const agent = deps.adminStore.agents.create({
    agentId,
    ...(displayName !== undefined ? { displayName } : {}),
    ...(homeDir !== undefined ? { homeDir } : {}),
    status,
    actor,
    now: new Date().toISOString(),
  })
  return json({ agent }, 201)
}

export const handleListAdminAgents: RouteHandler = async ({ deps }) => {
  return json({ agents: deps.adminStore.agents.list() })
}

export const handleGetAdminAgent: RouteHandler = async ({ params, deps }) => {
  const agent = deps.adminStore.agents.get(requireAgentId(params))
  if (agent === undefined) {
    notFound('agent not found', { agentId: params['agentId'] })
  }

  return json({ agent })
}

export const handlePatchAdminAgent: RouteHandler = async (context) => {
  const { request, params, deps } = context
  const agentId = requireAgentId(params)
  const existing = deps.adminStore.agents.get(agentId)
  if (existing === undefined) {
    notFound('agent not found', { agentId })
  }

  const body = requireRecord(await parseJsonBody(request))
  const displayName = readOptionalTrimmedStringField(body, 'displayName')
  const homeDir = readOptionalTrimmedStringField(body, 'homeDir')
  // Allow explicit null to clear homeDir
  const homeDirIsNull = body['homeDir'] === null
  const status = body['status'] === undefined ? undefined : parseAgentStatus(body['status'])
  const actor = requireActor(context)
  const agent = deps.adminStore.agents.patch({
    agentId,
    ...(displayName !== undefined ? { displayName } : {}),
    ...(homeDir !== undefined ? { homeDir } : homeDirIsNull ? { homeDir: null } : {}),
    ...(status !== undefined ? { status } : {}),
    actor,
    now: new Date().toISOString(),
  })

  return json({ agent: agent ?? existing })
}
