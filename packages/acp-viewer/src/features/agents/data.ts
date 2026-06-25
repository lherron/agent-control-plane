import { fetchJson, getAgentDetail } from '@/lib/api'
import type { AgentDetailResponse, AgentHeartbeat, AgentSummary } from '@/types/api'

export async function fetchAgentDetail(agentId: string): Promise<AgentDetailResponse> {
  return getAgentDetail(agentId)
}

export async function fetchAgents(): Promise<AgentSummary[]> {
  const payload = await fetchJson<AgentSummary[] | { agents: AgentSummary[] }>('/v1/admin/agents')
  return Array.isArray(payload) ? payload : payload.agents
}

export async function fetchAgentHeartbeat(agentId: string): Promise<AgentHeartbeat | null> {
  const payload = await fetchJson<{ heartbeat: AgentHeartbeat | null }>(
    `/v1/admin/agents/${encodeURIComponent(agentId)}/heartbeat`
  )
  return payload.heartbeat
}
