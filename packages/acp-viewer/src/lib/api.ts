import type {
  AgentDetailResponse,
  AgentSystemPromptResponse,
  ContextRunMode,
  JobDetailResponse,
  JobRecord,
  JobsListResponse,
  ProjectDetailResponse,
} from '@/types/api'

const BASE_URL =
  import.meta.env.VITE_ACP_VIEWER_API_BASE_URL ??
  (import.meta.env.DEV ? '' : 'http://127.0.0.1:18470')

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`)
  if (!res.ok) {
    throw new Error(`API ${res.status}: ${path}`)
  }
  return res.json() as Promise<T>
}

// --- Projects ---

export function getProjectDetail(projectId: string): Promise<ProjectDetailResponse> {
  return fetchJson<ProjectDetailResponse>(
    `/v1/admin/projects/${encodeURIComponent(projectId)}/detail`
  )
}

// --- Agents ---

export function getAgentDetail(agentId: string): Promise<AgentDetailResponse> {
  return fetchJson<AgentDetailResponse>(`/v1/admin/agents/${encodeURIComponent(agentId)}/detail`)
}

export function getAgentSystemPrompt(
  agentId: string,
  options: { runMode?: ContextRunMode | undefined; projectId?: string | undefined } = {}
): Promise<AgentSystemPromptResponse> {
  const params = new URLSearchParams()
  if (options.runMode !== undefined) {
    params.set('runMode', options.runMode)
  }
  if (options.projectId !== undefined && options.projectId.length > 0) {
    params.set('projectId', options.projectId)
  }

  const query = params.size > 0 ? `?${params.toString()}` : ''
  return fetchJson<AgentSystemPromptResponse>(
    `/v1/admin/agents/${encodeURIComponent(agentId)}/system-prompt${query}`
  )
}

// --- Jobs ---

export async function listJobs(): Promise<JobRecord[]> {
  const data = await fetchJson<JobsListResponse>('/v1/admin/jobs')
  return data.jobs
}

export function getJobDetail(jobId: string): Promise<JobDetailResponse> {
  return fetchJson<JobDetailResponse>(`/v1/admin/jobs/${encodeURIComponent(jobId)}/detail`)
}
