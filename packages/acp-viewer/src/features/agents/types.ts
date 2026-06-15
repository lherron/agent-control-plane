import type { AgentSummary, ProjectSummary, ProvenanceEntry } from '@/types/api'

export interface AgentHeartbeat {
  agentId: string
  lastHeartbeatAt: string
  source?: string | undefined
  lastNote?: string | undefined
  status: 'alive' | 'stale' | string
  targetScopeRef?: string | undefined
  targetLaneRef?: string | undefined
}

export interface AgentMembership {
  agentId: string
  projectId: string
  role: string
  createdAt: string
  project?: ProjectSummary | undefined
  isDefaultAgent?: boolean | undefined
}

export interface CompactJobRecord {
  jobId: string
  projectId: string
  agentId?: string | undefined
  scopeRef?: string | undefined
  laneRef?: string | undefined
  disabled?: boolean | undefined
  schedule?: { cron?: string | undefined } | undefined
  nextFireAt?: string | null | undefined
}

export interface CompactJobSummary {
  kind?: string | undefined
  projectId?: string | undefined
  disabled?: boolean | undefined
  cron?: string | null | undefined
  nextFireAt?: string | null | undefined
  flowStepCount?: number | undefined
  title?: string | undefined
}

export interface AgentJobSummary {
  job?: CompactJobRecord | undefined
  summary?: CompactJobSummary | undefined
}

export interface ScopeTarget {
  scopeRef: string
  laneRef: string
  source: 'membership' | 'job' | string
}

export interface AgentDetailState {
  agent: AgentSummary
  memberships: AgentMembership[]
  jobs: AgentJobSummary[]
  heartbeat?: AgentHeartbeat | null | undefined
  scopeTargets: ScopeTarget[]
  provenance: ProvenanceEntry[]
}
