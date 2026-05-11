import type {
  AgentDetailResponse,
  AgentSummary,
  HeartbeatSummary,
  JobDetailResponse,
  JobRecord,
  JobsListResponse,
  ProjectDetailResponse,
  ProjectSummary,
  SchedulerStateResponse,
} from '@/types/api'

const BASE_URL = import.meta.env.VITE_ACP_VIEWER_API_BASE_URL ?? 'http://127.0.0.1:18470'

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`)
  if (!res.ok) {
    throw new Error(`API ${res.status}: ${path}`)
  }
  return res.json() as Promise<T>
}

// --- Projects ---

export function listProjects(): Promise<ProjectSummary[]> {
  return fetchJson<ProjectSummary[]>('/v1/admin/projects')
}

export function getProjectDetail(projectId: string): Promise<ProjectDetailResponse> {
  return fetchJson<ProjectDetailResponse>(
    `/v1/admin/projects/${encodeURIComponent(projectId)}/detail`
  )
}

// --- Agents ---

export function listAgents(): Promise<AgentSummary[]> {
  return fetchJson<AgentSummary[]>('/v1/admin/agents')
}

export function getAgentDetail(agentId: string): Promise<AgentDetailResponse> {
  return fetchJson<AgentDetailResponse>(`/v1/admin/agents/${encodeURIComponent(agentId)}/detail`)
}

// --- Jobs ---

export async function listJobs(): Promise<JobRecord[]> {
  const data = await fetchJson<JobsListResponse>('/v1/admin/jobs')
  return data.jobs
}

export function getJobDetail(jobId: string): Promise<JobDetailResponse> {
  return fetchJson<JobDetailResponse>(`/v1/admin/jobs/${encodeURIComponent(jobId)}/detail`)
}

// --- Scheduler ---

export function getSchedulerState(): Promise<SchedulerStateResponse> {
  return fetchJson<SchedulerStateResponse>('/v1/admin/jobs/scheduler')
}

// --- Agent Heartbeat ---

export function getAgentHeartbeat(agentId: string): Promise<HeartbeatSummary | null> {
  return fetchJson<HeartbeatSummary | null>(
    `/v1/admin/agents/${encodeURIComponent(agentId)}/heartbeat`
  )
}
