import type {
  AgentDetailResponse,
  AgentHeartbeat,
  AgentMembership,
  DetailJobSummary,
  ScopeTarget,
} from '@/types/api'

export type AgentDetailState = AgentDetailResponse
export type AgentJobSummary = DetailJobSummary
export type { AgentHeartbeat, AgentMembership, ScopeTarget }
