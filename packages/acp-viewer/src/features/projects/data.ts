import { fetchJson, getProjectDetail } from '@/lib/api'
import type { ProjectDetailResponse, ProjectSummary } from '@/types/api'

export async function fetchProjects(): Promise<ProjectSummary[]> {
  const payload = await fetchJson<ProjectSummary[] | { projects: ProjectSummary[] }>(
    '/v1/admin/projects'
  )
  return Array.isArray(payload) ? payload : payload.projects
}

export async function fetchProjectDetail(projectId: string): Promise<ProjectDetailResponse> {
  return getProjectDetail(projectId)
}
