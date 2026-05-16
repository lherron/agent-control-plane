import { getAgentDetail, getAgentSystemPrompt } from '@/lib/api'
import type { AgentSummary, AgentSystemPromptResponse, ContextRunMode } from '@/types/api'
import type { AgentDetailState, AgentHeartbeat } from './types'

const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env
const BASE_URL = env?.VITE_ACP_VIEWER_API_BASE_URL ?? (env?.DEV ? '' : 'http://127.0.0.1:18470')

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`)
  if (!res.ok) {
    throw new Error(`API ${res.status}: ${path}`)
  }
  return res.json() as Promise<T>
}

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

export async function fetchAgentSystemPrompt(
  agentId: string,
  options: { runMode?: ContextRunMode | undefined; projectId?: string | undefined } = {}
): Promise<AgentSystemPromptResponse> {
  return getAgentSystemPrompt(agentId, options)
}
