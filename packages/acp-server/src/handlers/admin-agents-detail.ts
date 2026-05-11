import { badRequest, json, notFound } from '../http.js'

import type { RouteHandler } from '../routing/route-context.js'
import { provenance, summarizeCompactJob } from './admin-detail-shared.js'

function requireAgentId(params: Record<string, string>): string {
  const agentId = params['agentId']
  if (agentId === undefined || agentId.length === 0) {
    badRequest('agentId route param is required', { field: 'agentId' })
  }

  return agentId
}

function addScopeTarget(
  targets: Array<{ scopeRef: string; laneRef: string; source: 'membership' | 'job' }>,
  seen: Set<string>,
  target: { scopeRef: string; laneRef: string; source: 'membership' | 'job' }
): void {
  const key = `${target.scopeRef}\u0000${target.laneRef}\u0000${target.source}`
  if (seen.has(key)) {
    return
  }
  seen.add(key)
  targets.push(target)
}

export const handleGetAdminAgentDetail: RouteHandler = async ({ params, deps }) => {
  const agentId = requireAgentId(params)
  const agent = deps.adminStore.agents.get(agentId)
  if (agent === undefined) {
    notFound('agent not found', { agentId })
  }

  const projects = deps.adminStore.projects.list()
  const memberships = projects.flatMap((project) =>
    deps.adminStore.memberships
      .listByProject(project.projectId)
      .filter((membership) => membership.agentId === agentId)
      .map((membership) => ({
        ...membership,
        project,
        isDefaultAgent: project.defaultAgentId === agentId,
      }))
  )
  const jobs = (deps.jobsStore?.listJobs().jobs ?? [])
    .filter((job) => job.agentId === agentId)
    .map((job) => ({
      job,
      summary: {
        ...summarizeCompactJob(job),
        projectId: job.projectId,
      },
    }))
  const heartbeat = deps.adminStore.heartbeats.get(agentId)
  const scopeTargets: Array<{ scopeRef: string; laneRef: string; source: 'membership' | 'job' }> =
    []
  const seenScopeTargets = new Set<string>()

  for (const membership of memberships) {
    addScopeTarget(scopeTargets, seenScopeTargets, {
      scopeRef: `agent:${agentId}:project:${membership.projectId}`,
      laneRef: 'main',
      source: 'membership',
    })
  }

  for (const { job } of jobs) {
    addScopeTarget(scopeTargets, seenScopeTargets, {
      scopeRef: job.scopeRef,
      laneRef: job.laneRef,
      source: 'job',
    })
  }

  return json({
    agent,
    memberships,
    jobs,
    ...(heartbeat !== undefined ? { heartbeat } : {}),
    scopeTargets,
    provenance: [
      provenance('admin_store.agents', true),
      provenance('admin_store.projects', true),
      provenance('admin_store.memberships', true),
      provenance('jobs_store.jobs', deps.jobsStore !== undefined),
      provenance('admin_store.agent_heartbeats', true),
    ],
  })
}
