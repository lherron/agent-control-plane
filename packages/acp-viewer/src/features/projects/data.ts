import { fetchJson, getProjectDetail } from '@/lib/api'
import type { ProjectSummary } from '@/types/api'
import type { ProjectDetailState } from './types'

export async function fetchProjects(): Promise<ProjectSummary[]> {
  const payload = await fetchJson<ProjectSummary[] | { projects: ProjectSummary[] }>(
    '/v1/admin/projects'
  )
  return Array.isArray(payload) ? payload : payload.projects
}

export async function fetchProjectDetail(projectId: string): Promise<ProjectDetailState> {
  return getProjectDetail(projectId) as unknown as ProjectDetailState
}
