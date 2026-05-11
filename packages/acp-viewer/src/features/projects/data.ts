import { getProjectDetail } from '@/lib/api'
import type { ProjectSummary } from '@/types/api'
import type { ProjectDetailState } from './types'

const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env
const BASE_URL =
  env?.VITE_ACP_VIEWER_API_BASE_URL ?? (env?.DEV ? '' : 'http://127.0.0.1:18470')

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`)
  if (!res.ok) {
    throw new Error(`API ${res.status}: ${path}`)
  }
  return res.json() as Promise<T>
}

export async function fetchProjects(): Promise<ProjectSummary[]> {
  const payload = await fetchJson<ProjectSummary[] | { projects: ProjectSummary[] }>(
    '/v1/admin/projects'
  )
  return Array.isArray(payload) ? payload : payload.projects
}

export async function fetchProjectDetail(projectId: string): Promise<ProjectDetailState> {
  return getProjectDetail(projectId) as unknown as ProjectDetailState
}
