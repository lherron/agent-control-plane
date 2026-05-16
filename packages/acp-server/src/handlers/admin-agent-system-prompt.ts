import { dirname, join } from 'node:path'
import { type RunMode, getAgentsRoot, getAspHome } from 'spaces-config'
import { inspectAgentSystemPrompt } from 'spaces-runtime'

import { badRequest, json, notFound } from '../http.js'
import type { RouteHandler } from '../routing/route-context.js'
import { provenance } from './admin-detail-shared.js'

function requireAgentId(params: Record<string, string>): string {
  const agentId = params['agentId']
  if (agentId === undefined || agentId.length === 0) {
    badRequest('agentId route param is required', { field: 'agentId' })
  }

  return agentId
}

function parseRunMode(value: string | null): RunMode {
  if (value === null || value.length === 0) {
    return 'query'
  }

  if (value === 'query' || value === 'heartbeat' || value === 'task' || value === 'maintenance') {
    return value
  }

  badRequest('runMode must be one of: query, heartbeat, task, maintenance', {
    field: 'runMode',
  })
}

export const handleGetAdminAgentSystemPrompt: RouteHandler = async ({ params, url, deps }) => {
  const agentId = requireAgentId(params)
  const agent = deps.adminStore.agents.get(agentId)
  if (agent === undefined) {
    notFound('agent not found', { agentId })
  }

  const configuredAgentsRoot = getAgentsRoot()
  const agentRoot =
    agent.homeDir ?? (configuredAgentsRoot ? join(configuredAgentsRoot, agentId) : undefined)
  if (agentRoot === undefined) {
    badRequest('agent homeDir is required when agents-root is not configured', {
      field: 'homeDir',
      agentId,
    })
  }

  const projectId = url.searchParams.get('projectId')
  const runMode = parseRunMode(url.searchParams.get('runMode'))
  const project = projectId === null ? undefined : deps.adminStore.projects.get(projectId)
  if (projectId !== null && project === undefined) {
    notFound('project not found', { projectId })
  }

  const projectRoot = project?.homeDir ?? project?.rootDir
  const inspection = await inspectAgentSystemPrompt({
    agentRoot,
    agentsRoot:
      agent.homeDir === undefined && configuredAgentsRoot
        ? configuredAgentsRoot
        : dirname(agentRoot),
    aspHome: getAspHome(),
    ...(projectRoot !== undefined ? { projectRoot } : {}),
    ...(projectId !== null ? { projectId } : {}),
    runMode,
  })

  return json({
    systemPrompt: inspection ?? null,
    provenance: [
      provenance('admin_store.agents', true),
      provenance('admin_store.projects', projectId === null || project !== undefined),
      provenance('spaces_runtime.inspectAgentSystemPrompt', inspection !== undefined),
    ],
  })
}
