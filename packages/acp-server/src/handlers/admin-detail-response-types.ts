import type {
  AdminAgent,
  AdminMembership,
  AdminProject,
  AgentHeartbeat,
  InterfaceBinding,
  SystemEvent,
} from 'acp-core'
import type { JobRecord } from 'acp-jobs-store'

import type { CompactJobSummary, ProvenanceEntry } from './admin-detail-shared.js'

export type AdminDetailJobSummary = {
  job: JobRecord
  summary: CompactJobSummary
}

export type AdminProjectDetailResponse = {
  project: AdminProject
  defaultAgent?: AdminAgent | undefined
  memberships: Array<AdminMembership & { agent?: AdminAgent | undefined }>
  jobs: AdminDetailJobSummary[]
  interfaceBindings: InterfaceBinding[]
  recentSystemEvents: SystemEvent[]
  provenance: ProvenanceEntry[]
}

export type AdminAgentDetailResponse = {
  agent: AdminAgent
  memberships: Array<
    AdminMembership & { project?: AdminProject | undefined; isDefaultAgent: boolean }
  >
  jobs: AdminDetailJobSummary[]
  heartbeat?: AgentHeartbeat | undefined
  scopeTargets: Array<{ scopeRef: string; laneRef: string; source: 'membership' | 'job' }>
  provenance: ProvenanceEntry[]
}
