import { fetchJson, getAgentDetail } from '@/lib/api'
import type { AgentSummary } from '@/types/api'
import type { AgentDetailState, AgentHeartbeat } from './types'

export async function fetchAgentDetail(agentId: string): Promise<AgentDetailState> {
  return getAgentDetail(agentId) as unknown as AgentDetailState
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
