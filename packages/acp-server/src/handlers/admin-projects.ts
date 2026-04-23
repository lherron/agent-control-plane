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

function requireProjectId(params: Record<string, string>): string {
  const projectId = params['projectId']
  if (projectId === undefined || projectId.length === 0) {
    badRequest('projectId route param is required', { field: 'projectId' })
  }

  return projectId
}

export const handleCreateAdminProject: RouteHandler = async (context) => {
  const { request, deps } = context
  const body = requireRecord(await parseJsonBody(request))
  const projectId = requireTrimmedStringField(body, 'projectId')
  const displayName = requireTrimmedStringField(body, 'displayName')
  const rootDir = readOptionalTrimmedStringField(body, 'rootDir')
  const actor = requireActor(context)
  const existing = deps.adminStore.projects.get(projectId)

  if (existing !== undefined) {
    if (existing.displayName === displayName) {
      return json({ project: existing }, 200)
    }

    conflict('project already exists', { projectId })
  }

  const project = deps.adminStore.projects.create({
    projectId,
    displayName,
    ...(rootDir !== undefined ? { rootDir } : {}),
    actor,
    now: new Date().toISOString(),
  })
  return json({ project }, 201)
}

export const handleListAdminProjects: RouteHandler = async ({ deps }) => {
  return json({ projects: deps.adminStore.projects.list() })
}

export const handleGetAdminProject: RouteHandler = async ({ params, deps }) => {
  const projectId = requireProjectId(params)
  const project = deps.adminStore.projects.get(projectId)
  if (project === undefined) {
    notFound('project not found', { projectId })
  }

  return json({ project })
}

export const handleSetProjectDefaultAgent: RouteHandler = async (context) => {
  const { request, params, deps } = context
  const projectId = requireProjectId(params)
  const project = deps.adminStore.projects.get(projectId)
  if (project === undefined) {
    notFound('project not found', { projectId })
  }

  const body = requireRecord(await parseJsonBody(request))
  const agentId = requireTrimmedStringField(body, 'agentId')
  const actor = requireActor(context)
  if (deps.adminStore.agents.get(agentId) === undefined) {
    notFound('agent not found', { agentId })
  }

  // Validate that the agent is a member of this project
  const memberships = deps.adminStore.memberships.listByProject(projectId)
  const isMember = memberships.some((m) => m.agentId === agentId)
  if (!isMember) {
    badRequest('agent is not a member of this project', { agentId, projectId })
  }

  const updated = deps.adminStore.projects.setDefaultAgent({
    projectId,
    agentId,
    actor,
    now: new Date().toISOString(),
  })

  return json({ project: updated ?? project })
}
