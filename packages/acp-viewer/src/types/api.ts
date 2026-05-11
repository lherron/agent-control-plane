/** Viewer-local response types — no imports from acp-server. */

export interface ProjectSummary {
  projectId: string
  displayName: string
  defaultAgentId: string | null
  rootDir: string
  createdAt: string
  updatedAt: string
  createdBy: string
  updatedBy: string
}

export interface MembershipSummary {
  agentId: string
  projectId: string
  role: string
  status: string
  createdAt: string
}

export interface ProjectDetailResponse {
  project: ProjectSummary
  memberships: MembershipSummary[]
  jobs: JobSummary[]
  interfaces: InterfaceBindingSummary[]
  systemEvents: SystemEvent[]
}

export interface AgentSummary {
  agentId: string
  displayName: string
  homeDir: string
  status: string
  createdAt: string
  updatedAt: string
  createdBy: string
  updatedBy: string
}

export interface AgentDetailResponse {
  agent: AgentSummary
  memberships: MembershipSummary[]
  heartbeat: HeartbeatSummary | null
  jobs: JobSummary[]
}

export interface HeartbeatSummary {
  agentId: string
  lastSeen: string
  status: string
}

export interface JobSummary {
  jobId: string
  projectId: string
  name: string
  kind: string
  disabled: boolean
  cron: string | null
  nextFireAt: string | null
  flowStepCount: number
  createdAt: string
  updatedAt: string
}

export interface JobFlowStep {
  stepId: string
  name: string
  kind: string
  agentId: string | null
  dependsOn: string[]
  config: Record<string, unknown>
}

export interface JobDetailResponse {
  job: JobSummary
  flow: JobFlowStep[]
  recentRuns: JobRunSummary[]
}

export interface JobRunSummary {
  runId: string
  jobId: string
  status: string
  startedAt: string
  completedAt: string | null
  durationMs: number | null
}

export interface SchedulerStateResponse {
  enabled: boolean
  tickIntervalMs: number
  upcomingFires: UpcomingFire[]
  stats: SchedulerStats
}

export interface UpcomingFire {
  jobId: string
  jobName: string
  nextFireAt: string
  cron: string
}

export interface SchedulerStats {
  totalJobs: number
  enabledJobs: number
  disabledJobs: number
  lastTickAt: string | null
}

export interface InterfaceBindingSummary {
  bindingId: string
  projectId: string
  gatewayId: string
  conversationRef: string
  threadRef: string | null
  scopeRef: string | null
  laneRef: string | null
  status: string
}

export interface SystemEvent {
  eventId: string
  projectId: string
  kind: string
  payload: Record<string, unknown>
  createdAt: string
}
