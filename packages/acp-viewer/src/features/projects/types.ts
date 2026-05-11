import type { AgentSummary, InterfaceBindingSummary, ProjectSummary } from '@/types/api'

export interface ProvenanceItem {
  source: string
  available: boolean
}

export interface ProjectMembership {
  agentId: string
  projectId: string
  role: string
  status?: string | undefined
  createdAt: string
  agent?: AgentSummary | undefined
}

export interface CompactJobRecord {
  jobId: string
  projectId: string
  agentId?: string | undefined
  scopeRef?: string | undefined
  laneRef?: string | undefined
  disabled?: boolean | undefined
  schedule?: { cron?: string | undefined } | undefined
  cron?: string | null | undefined
  nextFireAt?: string | null | undefined
  lastFireAt?: string | null | undefined
  createdAt?: string | undefined
  updatedAt?: string | undefined
}

export interface CompactJobSummary {
  kind?: string | undefined
  projectId?: string | undefined
  disabled?: boolean | undefined
  cron?: string | null | undefined
  nextFireAt?: string | null | undefined
  lastFireAt?: string | null | undefined
  flowStepCount?: number | undefined
  onFailureStepCount?: number | undefined
  title?: string | undefined
  description?: string | undefined
}

export interface ProjectJobSummary {
  job?: CompactJobRecord | undefined
  summary?: CompactJobSummary | undefined
}

export interface ProjectSystemEvent {
  eventId: string
  projectId: string
  kind: string
  payload: Record<string, unknown>
  occurredAt?: string | undefined
  recordedAt?: string | undefined
  createdAt?: string | undefined
}

export interface ProjectDetailState {
  project: ProjectSummary
  defaultAgent?: AgentSummary | undefined
  memberships: ProjectMembership[]
  jobs: ProjectJobSummary[]
  interfaceBindings: InterfaceBindingSummary[]
  recentSystemEvents: ProjectSystemEvent[]
  provenance: ProvenanceItem[]
}
