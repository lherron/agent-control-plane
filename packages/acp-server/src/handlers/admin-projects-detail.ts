import { badRequest, json, notFound } from '../http.js'
import { toApiInterfaceBinding } from './interface-shared.js'

import type { RouteHandler } from '../routing/route-context.js'
import { provenance, summarizeCompactJob } from './admin-detail-shared.js'

function requireProjectId(params: Record<string, string>): string {
  const projectId = params['projectId']
  if (projectId === undefined || projectId.length === 0) {
    badRequest('projectId route param is required', { field: 'projectId' })
  }

  return projectId
}

export const handleGetAdminProjectDetail: RouteHandler = async ({ params, deps }) => {
  const projectId = requireProjectId(params)
  const project = deps.adminStore.projects.get(projectId)
  if (project === undefined) {
    notFound('project not found', { projectId })
  }

  const memberships = deps.adminStore.memberships.listByProject(projectId).map((membership) => {
    const agent = deps.adminStore.agents.get(membership.agentId)
    return {
      ...membership,
      ...(agent !== undefined ? { agent } : {}),
    }
  })
  const jobs = (deps.jobsStore?.listJobs({ projectId }).jobs ?? []).map((job) => ({
    job,
    summary: summarizeCompactJob(job),
  }))
  const interfaceBindings = deps.interfaceStore.bindings
    .list({ projectId })
    .map(toApiInterfaceBinding)
  const recentSystemEvents = deps.adminStore.systemEvents.list({ projectId }).slice(-25).reverse()
  const defaultAgent =
    project.defaultAgentId === undefined
      ? undefined
      : deps.adminStore.agents.get(project.defaultAgentId)

  return json({
    project,
    ...(defaultAgent !== undefined ? { defaultAgent } : {}),
    memberships,
    jobs,
    interfaceBindings,
    recentSystemEvents,
    provenance: [
      provenance('admin_store.projects', true),
      provenance('admin_store.memberships', true),
      provenance('admin_store.agents', true),
      provenance('jobs_store.jobs', deps.jobsStore !== undefined),
      provenance('interface_store.interface_bindings', true),
      provenance('admin_store.system_events', true),
    ],
  })
}
