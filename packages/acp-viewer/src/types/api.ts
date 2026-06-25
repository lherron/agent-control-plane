/** Viewer-local response types — no imports from acp-server. */

export interface Actor {
  kind: 'human' | 'agent' | 'system'
  id: string
  displayName?: string | undefined
}

export interface ProjectSummary {
  projectId: string
  displayName: string
  defaultAgentId?: string | undefined
  homeDir?: string | undefined
  rootDir?: string | undefined
  createdAt: string
  updatedAt: string
  createdBy: Actor
  updatedBy: Actor
}

export interface AgentSummaryProfile {
  displayColor?: string | undefined
  monogram?: string | undefined
  avatarUrl?: string | undefined
  tagline?: string | undefined
  role?: string | undefined
  defaultModel?: string | undefined
  vibe?: string[] | undefined
  specialties?: string[] | undefined
}

export interface AgentSummary {
  agentId: string
  displayName?: string | undefined
  homeDir?: string | undefined
  status: string
  createdAt: string
  updatedAt: string
  createdBy: Actor
  updatedBy: Actor
  profile?: AgentSummaryProfile | undefined
}

export interface MembershipSummary {
  agentId: string
  projectId: string
  role: string
  createdAt: string
  createdBy: Actor
}

export interface ProjectMembership extends MembershipSummary {
  agent?: AgentSummary | undefined
}

export interface AgentMembership extends MembershipSummary {
  project?: ProjectSummary | undefined
  isDefaultAgent: boolean
}

export interface CompactJobRecord {
  jobId: string
  slug?: string | undefined
  description?: string | undefined
  projectId: string
  agentId: string
  scopeRef?: string | undefined
  laneRef?: string | undefined
  schedule?: { cron?: string | undefined } | undefined
  cron?: string | null | undefined
  disabled?: boolean | undefined
  nextFireAt?: string | null | undefined
  lastFireAt?: string | null | undefined
  createdAt?: string | undefined
  updatedAt?: string | undefined
}

export interface CompactJobSummary {
  kind: JobKind
  projectId?: string | undefined
  disabled: boolean
  cron?: string | null | undefined
  nextFireAt?: string | null | undefined
  lastFireAt?: string | null | undefined
  flowStepCount: number
  onFailureStepCount: number
  title?: string | undefined
  description?: string | undefined
}

export interface DetailJobSummary {
  job: CompactJobRecord
  summary: CompactJobSummary
}

export interface ProjectSystemEvent {
  eventId: string
  projectId: string
  kind: string
  payload: Record<string, unknown>
  occurredAt: string
  recordedAt: string
}

export interface ProjectDetailResponse {
  project: ProjectSummary
  defaultAgent?: AgentSummary | undefined
  memberships: ProjectMembership[]
  jobs: DetailJobSummary[]
  interfaceBindings: InterfaceBindingSummary[]
  recentSystemEvents: ProjectSystemEvent[]
  provenance: ProvenanceEntry[]
}

export interface AgentHeartbeat {
  agentId: string
  lastHeartbeatAt: string
  source?: string | undefined
  lastNote?: string | undefined
  status: 'alive' | 'stale'
  targetScopeRef?: string | undefined
  targetLaneRef?: string | undefined
}

export interface ScopeTarget {
  scopeRef: string
  laneRef: string
  source: 'membership' | 'job'
}

export interface AgentDetailResponse {
  agent: AgentSummary
  memberships: AgentMembership[]
  heartbeat?: AgentHeartbeat | undefined
  jobs: DetailJobSummary[]
  scopeTargets: ScopeTarget[]
  provenance: ProvenanceEntry[]
}

export type ContextRunMode = 'query' | 'heartbeat' | 'task' | 'maintenance'

export interface AgentSystemPromptResponse {
  systemPrompt: AgentSystemPromptInspection | null
  provenance: ProvenanceEntry[]
}

export interface AgentSystemPromptInspection {
  agentRoot: string
  agentsRoot: string
  agentName: string
  runMode: ContextRunMode
  projectRoot?: string | undefined
  projectId?: string | undefined
  template: {
    kind: 'context' | 'built-in'
    path?: string | undefined
    mode: 'replace' | 'append'
    maxChars?: number | undefined
  }
  prompt: {
    content: string
    mode: 'replace' | 'append'
    totalChars: number
    sections: ContextPromptSection[]
  }
  reminder: {
    content?: string | undefined
    totalChars: number
    sections: ContextPromptSection[]
  }
  diagnostics: {
    prompt: { sectionSizes: string[]; totalChars: number }
    reminder: { sectionSizes: string[]; totalChars: number }
    totalChars: number
    maxChars?: number | undefined
    nearMaxChars: boolean
  }
}

export interface ContextPromptSection {
  zone: 'prompt' | 'reminder'
  name: string
  type: 'file' | 'inline' | 'exec' | 'slot'
  source: string
  included: boolean
  chars: number
  bytes: number
  truncated: boolean
  when?: { runMode?: string | undefined; exists?: string | undefined } | undefined
  maxChars?: number | undefined
  content?: string | undefined
  skippedReason?: 'when' | 'empty' | undefined
}

export type HeartbeatSummary = AgentHeartbeat

// --- Jobs (matches real backend shapes) ---

export interface JobRecord {
  jobId: string
  slug: string
  description?: string | undefined
  projectId: string
  agentId: string
  scopeRef: string
  laneRef: string
  schedule: JobSchedule
  input: Record<string, unknown>
  flow?: JobFlow | undefined
  disabled: boolean
  lastFireAt?: string | undefined
  nextFireAt?: string | undefined
  actor: Actor
  actorStamp?: string | undefined
  createdAt: string
  updatedAt: string
}

export interface JobSchedule {
  cron: string
  windowStart?: string | undefined
  windowEnd?: string | undefined
  windowMinutes?: number | undefined
  [key: string]: unknown
}

export interface JobFlow {
  sequence: JobFlowStep[]
  onFailure?: JobFlowStep[] | undefined
}

export type JobFlowStep = AgentFlowStep | ExecFlowStep

export interface BaseFlowStep {
  id: string
  kind?: 'agent' | 'exec' | undefined
  timeout?: string | undefined
  fresh?: boolean | undefined
  next?: string | undefined
}

export interface AgentFlowStep extends BaseFlowStep {
  kind?: 'agent' | undefined
  input?: string | undefined
  inputFile?: string | undefined
  expect?: StepExpectation | undefined
}

export interface ExecFlowStep extends BaseFlowStep {
  kind: 'exec'
  exec: {
    argv: string[]
    cwd?: string | undefined
    env?: Record<string, string> | undefined
    timeout?: string | undefined
    maxOutputBytes?: number | undefined
  }
  branches?:
    | {
        exitCode?: Record<string, string> | undefined
        default?: string | undefined
      }
    | undefined
}

export interface StepExpectation {
  outcome?: 'succeeded' | 'failed' | 'cancelled' | undefined
  resultBlock?: string | undefined
  require?: string[] | undefined
  equals?: Record<string, string | number | boolean | null> | undefined
}

export type JobKind = 'input' | 'flow' | 'exec'

export interface JobSummaryInfo {
  kind: JobKind
  title: string
  description?: string | undefined
  disabledReason?: string | undefined
  flowStepCount: number
  onFailureStepCount: number
}

export interface ScheduleSummary {
  cron: string
  lastFireAt?: string | undefined
  nextFireAt?: string | undefined
  nextFirePreview?: string[] | undefined
  windowStart?: string | undefined
  windowEnd?: string | undefined
  windowMinutes?: number | undefined
}

export interface StartupSummary {
  scopeRef: string
  laneRef: string
  input: Record<string, unknown>
  actor: Actor
}

export interface NormalizedFlowStep extends BaseFlowStep {
  phase: 'sequence' | 'onFailure'
  index: number
  // union fields surfaced
  input?: string | undefined
  inputFile?: string | undefined
  expect?: StepExpectation | undefined
  exec?: ExecFlowStep['exec'] | undefined
  branches?: ExecFlowStep['branches'] | undefined
}

export interface NormalizedFlowEdge {
  from: string
  to: string
  label: 'continue' | 'succeed' | 'fail' | 'onFailure'
}

export interface NormalizedFlow {
  nodes: NormalizedFlowStep[]
  sequence: NormalizedFlowStep[]
  onFailure: NormalizedFlowStep[]
  edges: NormalizedFlowEdge[]
  warnings: string[]
}

export interface ProvenanceEntry {
  source: string
  available: boolean
  note?: string | undefined
}

export interface JobRunRecord {
  jobRunId: string
  jobId: string
  triggeredAt: string
  triggeredBy: 'schedule' | 'manual' | 'catch-up'
  status: 'pending' | 'claimed' | 'dispatched' | 'succeeded' | 'failed' | 'skipped'
  inputAttemptId?: string | undefined
  runId?: string | undefined
  errorCode?: string | undefined
  errorMessage?: string | undefined
  leaseOwner?: string | undefined
  leaseExpiresAt?: string | undefined
  claimedAt?: string | undefined
  dispatchedAt?: string | undefined
  completedAt?: string | undefined
  actor: Actor
  actorStamp?: string | undefined
  createdAt: string
  updatedAt: string
}

export interface JobStepRunRecord {
  jobRunId: string
  stepId: string
  phase: 'sequence' | 'onFailure'
  status: 'pending' | 'claimed' | 'dispatched' | 'succeeded' | 'failed' | 'skipped'
  attempt: number
  inputAttemptId?: string | undefined
  runId?: string | undefined
  resultBlock?: string | undefined
  result?: Record<string, unknown> | undefined
  error?: { code: string; message: string } | undefined
  startedAt?: string | undefined
  completedAt?: string | undefined
  createdAt: string
  updatedAt: string
}

export interface JobDetailResponse {
  job: JobRecord
  summary: JobSummaryInfo
  schedule: ScheduleSummary
  startup: StartupSummary
  flow?: NormalizedFlow | undefined
  latestRuns: JobRunRecord[]
  provenance: ProvenanceEntry[]
  lineage: {
    project?: Record<string, unknown>
    agent?: Record<string, unknown>
    memberships: MembershipSummary[]
    interfaceBindings: InterfaceBindingSummary[]
    jobRuns: JobRunRecord[]
    stepRuns: Array<{ jobRunId: string; stepRun: JobStepRunRecord }>
    inputAttempts: Array<{ jobRunId: string; record: Record<string, unknown> }>
    runs: Array<{ jobRunId: string; run: Record<string, unknown> }>
  }
}

// --- Jobs list (matches GET /v1/admin/jobs) ---

export interface JobsListResponse {
  jobs: JobRecord[]
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
  gatewayId: string
  gatewayType: string
  conversationRef: string
  threadRef?: string | undefined
  sessionRef: {
    scopeRef: string
    laneRef: string
  }
  projectId?: string | undefined
  agentId?: string | undefined
  taskId?: string | undefined
  roleName?: string | undefined
  status: string
  createdAt: string
  updatedAt: string
}

export interface SystemEvent {
  eventId: string
  projectId: string
  kind: string
  payload: Record<string, unknown>
  occurredAt: string
  recordedAt: string
}
