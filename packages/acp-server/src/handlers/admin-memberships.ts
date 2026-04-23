import { badRequest, conflict, json, notFound } from '../http.js'
import { parseJsonBody, requireRecord, requireTrimmedStringField } from '../parsers/body.js'

import type { RouteContext, RouteHandler } from '../routing/route-context.js'

function requireActor(context: RouteContext) {
  const actor = context.actor
  if (actor === undefined) {
    badRequest('actor is required', { field: 'actor' })
  }

  return actor
}

function parseMembershipRole(
  value: unknown
): 'coordinator' | 'implementer' | 'tester' | 'observer' {
  if (
    value !== 'coordinator' &&
    value !== 'implementer' &&
    value !== 'tester' &&
    value !== 'observer'
  ) {
    badRequest('role must be one of: coordinator, implementer, tester, observer', {
      field: 'role',
    })
  }

  return value
}

function requireProjectId(params: Record<string, string>): string {
  const projectId = params['projectId']
  if (projectId === undefined || projectId.length === 0) {
    badRequest('projectId route param is required', { field: 'projectId' })
  }

  return projectId
}

function requireProjectIdQuery(url: URL): string {
  const projectId = url.searchParams.get('projectId')?.trim()
  if (projectId === undefined || projectId.length === 0) {
    badRequest('projectId query param is required', { field: 'projectId' })
  }

  return projectId
}

export const handleCreateMembership: RouteHandler = async (context) => {
  const { request, deps } = context
  const body = requireRecord(await parseJsonBody(request))
  const projectId = requireTrimmedStringField(body, 'projectId')
  const agentId = requireTrimmedStringField(body, 'agentId')
  const role = parseMembershipRole(body['role'])
  const actor = requireActor(context)

  if (deps.adminStore.projects.get(projectId) === undefined) {
    notFound('project not found', { projectId })
  }
  if (deps.adminStore.agents.get(agentId) === undefined) {
    notFound('agent not found', { agentId })
  }

  const existing = deps.adminStore.memberships
    .listByProject(projectId)
    .find((membership) => membership.agentId === agentId)
  if (existing !== undefined) {
    if (existing.role === role) {
      return json({ membership: existing }, 200)
    }

    conflict('membership already exists', { projectId, agentId })
  }

  const membership = deps.adminStore.memberships.add({
    projectId,
    agentId,
    role,
    actor,
    now: new Date().toISOString(),
  })
  return json({ membership }, 201)
}

export const handleListProjectMemberships: RouteHandler = async ({ params, deps }) => {
  const projectId = requireProjectId(params)
  if (deps.adminStore.projects.get(projectId) === undefined) {
    notFound('project not found', { projectId })
  }

  return json({ memberships: deps.adminStore.memberships.listByProject(projectId) })
}

export const handleListMemberships: RouteHandler = async ({ url, deps }) => {
  const projectId = requireProjectIdQuery(url)
  if (deps.adminStore.projects.get(projectId) === undefined) {
    notFound('project not found', { projectId })
  }

  return json({ memberships: deps.adminStore.memberships.listByProject(projectId) })
}
