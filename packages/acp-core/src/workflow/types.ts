export type ActorRef =
  | { kind: 'agent'; id: string }
  | { kind: 'human'; id: string }
  | { kind: 'service'; id: string }
  | { kind: 'group'; id: string }

export type WorkStatus = 'open' | 'active' | 'waiting' | 'closed'

export interface WorkState {
  status: WorkStatus
  phase?: string | null | undefined
  outcome?: string | null | undefined
}

export type RoleBindings = Record<string, ActorRef | null>

export interface SupervisorCapabilities {
  launchRuns?: boolean | undefined
  sendInputToRuns?: boolean | undefined
  bindUnboundRoles?: boolean | undefined
  createObligations?: boolean | undefined
  satisfyObligations?: boolean | undefined
  createChildTasks?: boolean | undefined
  applySupervisorTransitions?: boolean | undefined
  requestHumanInput?: boolean | undefined
  proposeWorkflowPatches?: boolean | undefined
  createWaivers?: boolean | undefined
  pauseSupervision?: boolean | undefined
  attachEvidence?: boolean | undefined
  escalate?: boolean | undefined
}

export interface SupervisorBinding {
  actor: ActorRef
  autonomy: 'observe' | 'recommend' | 'managed' | 'autonomous'
  capabilities: SupervisorCapabilities
}

export interface RoleSpec {
  description?: string | undefined
  binding?: 'required' | 'optional' | 'autoBindOnFirstRun' | undefined
  mayBeSameAs?: string[] | undefined
  mustDifferFrom?: string[] | undefined
}

export interface EvidenceKindSpec {
  description?: string | undefined
  schemaRef?: string | undefined
  requiredFields?: string[] | undefined
}

export interface ObligationKindSpec {
  description?: string | undefined
  blockingDefault?: boolean | undefined
  ownerRoles?: string[] | undefined
  allowedSatisfactionEvidence?: string[] | undefined
}

export type BuiltInCondition =
  | { type: 'risk_at_least'; level: 'medium' | 'high' }
  | { type: 'risk_equals'; level: string }
  | { type: 'role_bound'; role: string }
  | { type: 'fact_equals'; path: string; value: unknown }
  | { type: 'no_open_blocking_obligations' }
  | { type: 'all_child_tasks_closed'; relation?: string | undefined }

export type Requirement =
  | { type: 'evidence'; kinds: string[]; mode?: 'all' | 'any' | undefined }
  | { type: 'sod'; actingRole: string; notSameAs: string[] }
  | { type: 'obligation_satisfied'; kind?: string | undefined; obligationId?: string | undefined }
  | { type: 'approval'; role: string }
  | { type: 'waiver'; waiverKind: string }

export type EffectTemplate =
  | {
      type: 'declare_handoff'
      toRole: string
      kind: string
      reason?: string | undefined
      when?: BuiltInCondition[] | undefined
    }
  | {
      type: 'wake_role_session'
      role: string
      reason?: string | undefined
      when?: BuiltInCondition[] | undefined
    }
  | {
      type: 'launch_participant_run'
      role: string
      promptRef?: string | undefined
      when?: BuiltInCondition[] | undefined
    }
  | {
      type: 'create_obligation'
      kind: string
      ownerRole?: string | undefined
      blocking?: boolean | undefined
      when?: BuiltInCondition[] | undefined
    }
  | {
      type: 'start_timer'
      duration: string
      reason?: string | undefined
      when?: BuiltInCondition[] | undefined
    }
  | {
      type: 'create_child_task'
      workflow: string
      relation: string
      when?: BuiltInCondition[] | undefined
    }

export interface TransitionSpec {
  id: string
  label?: string | undefined
  from: Partial<WorkState>
  to: Partial<WorkState>
  by?: string[] | undefined
  supervisorBypass?: boolean | undefined
  when?: BuiltInCondition[] | undefined
  requires?: Requirement[] | undefined
  effects?: EffectTemplate[] | undefined
  guidance?: Record<string, unknown> | undefined
}

export interface WorkflowDefinition {
  id: string
  version: number
  hash?: string | undefined
  kind: string
  initial: WorkState
  phases?: Record<string, Record<string, unknown>> | undefined
  outcomes?: Record<string, Record<string, unknown>> | undefined
  roles: Record<string, RoleSpec>
  evidenceKinds: Record<string, EvidenceKindSpec>
  obligationKinds?: Record<string, ObligationKindSpec> | undefined
  transitions: Record<string, TransitionSpec>
  supervisor?: Record<string, unknown> | undefined
}

export interface WorkflowRef {
  id: string
  version: number
  hash: string
}

export type PublishedWorkflowDefinition = WorkflowDefinition & {
  hash: string
  workflow: WorkflowRef
}

export interface WorkflowTask {
  taskId: string
  projectId: string
  workflow: WorkflowRef
  state: WorkState
  version: number
  goal: string
  risk?: string | undefined
  facts?: Record<string, unknown> | undefined
  roleBindings: RoleBindings
  supervisor?: SupervisorBinding | undefined
  createdAt: string
  updatedAt: string
}

export interface EvidenceInput {
  kind: string
  ref: string
  summary?: string | undefined
  data?: Record<string, unknown> | undefined
}

export interface EvidenceRecord extends EvidenceInput {
  evidenceId: string
  taskId: string
  actor?: ActorRef | undefined
  role?: string | undefined
  runId?: string | undefined
  participantRunId?: string | undefined
  supervisorRunId?: string | undefined
  schemaVersion?: number | undefined
  schemaHash?: string | undefined
  producedAt?: string | undefined
  taskVersionAtProduction?: number | undefined
  phaseAtProduction?: string | undefined
  transitionIntentId?: string | undefined
  artifactRefs?: string[] | undefined
  semanticValidation?:
    | {
        validatorId: string
        result: 'valid' | 'invalid' | 'inconclusive'
        reason?: string | undefined
      }
    | undefined
  createdAt: string
}

export interface ObligationRecord {
  obligationId: string
  taskId: string
  kind: string
  ownerRole?: string | undefined
  summary: string
  blocking: boolean
  status: 'open' | 'satisfied' | 'waived' | 'cancelled' | 'expired'
  createdAt: string
  updatedAt: string
  satisfiedAt?: string | undefined
  satisfactionEvidenceIds?: string[] | undefined
  waivedAt?: string | undefined
  waiverReason?: string | undefined
  waiverEvidenceRefs?: string[] | undefined
  cancelledAt?: string | undefined
  cancelReason?: string | undefined
  expiredAt?: string | undefined
  expireReason?: string | undefined
}

export interface EffectIntent {
  effectId: string
  taskId: string
  sourceEventId: string
  kind: string
  payload: Record<string, unknown>
  idempotencyKey: string
  state: 'pending' | 'leased' | 'delivered' | 'failed' | 'unsupported' | 'expired'
  createdAt: string
  updatedAt: string
}

export interface WorkflowEvent {
  eventId: string
  workflowSeq: number
  schemaVersion: number
  taskId: string
  workflow: WorkflowRef
  type: string
  commandType?: string | undefined
  commandHash?: string | undefined
  causationId?: string | undefined
  correlationId?: string | undefined
  actor: ActorRef
  role?: string | undefined
  authority?: string | undefined
  runId?: string | undefined
  supervisorRunId?: string | undefined
  participantRunId?: string | undefined
  observedTaskVersion: number
  nextTaskVersion?: number | undefined
  contextHash?: string | undefined
  idempotencyKey: string
  result: 'accepted' | 'rejected' | 'recorded'
  rejectionCode?: string | undefined
  payload: Record<string, unknown>
  eventHash: string
  prevHash?: string | undefined
  createdAt: string
}

export interface WorkflowHrcRunMap {
  mapId: string
  workflowTaskId: string
  participantRunId?: string | undefined
  supervisorRunId?: string | undefined
  hrcRunId: string
  runtimeId?: string | undefined
  launchId?: string | undefined
  hostSessionId?: string | undefined
  scopeRef?: string | undefined
  laneRef?: string | undefined
  generation?: number | undefined
  createdAt: string
  source: 'admission' | 'launch' | 'reconciled'
}

export type ParticipantRunStatus = 'launched' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface ParticipantRunRecord {
  runId: string
  kind: 'participant'
  taskId: string
  workflow: WorkflowRef
  actor: ActorRef
  role: string
  status: ParticipantRunStatus
  parentSupervisorRunId?: string | undefined
  taskVersionAtStart: number
  contextHash: string
  createdAt: string
  completedAt?: string | undefined
  outcome?: string | undefined
  summary?: string | undefined
  failureReason?: string | undefined
  failureClassification?: string | undefined
  cancelReason?: string | undefined
}

export interface SupervisorRunRecord {
  runId: string
  kind: 'workflow_supervisor'
  taskId: string
  workflow: WorkflowRef
  supervisor: ActorRef
  autonomy: SupervisorBinding['autonomy']
  capabilities: SupervisorCapabilities
  harness?: Record<string, unknown> | undefined
  taskVersionAtStart: number
  contextHash: string
  createdAt: string
  paused?: boolean | undefined
  pausedReason?: string | undefined
}

export interface WorkflowAnomaly {
  anomalyId: string
  taskId: string
  workflow: WorkflowRef
  supervisorRunId?: string | undefined
  category:
    | 'no_legal_transition'
    | 'missing_or_ambiguous_evidence_contract'
    | 'role_unavailable'
    | 'participant_repeated_failure'
    | 'prompt_template_failure'
    | 'external_dependency'
    | 'policy_conflict'
    | 'state_model_gap'
  stateAtObservation: WorkState
  taskVersion: number
  summary: string
  proposedRecovery?: string | undefined
  createdAt: string
}

export interface WorkflowPatchProposal {
  proposalId: string
  taskId: string
  baseWorkflow: WorkflowRef
  proposedVersion?: number | undefined
  sourceAnomalyIds: string[]
  patchKind:
    | 'add_transition'
    | 'change_requirement'
    | 'add_evidence_kind'
    | 'add_obligation_kind'
    | 'change_effect'
    | 'change_supervisor_guidance'
    | 'change_participant_template'
    | 'state_model_refinement'
  patch: unknown
  rationaleSummary: string
  status: 'proposed' | 'accepted' | 'rejected' | 'published'
  createdBy: ActorRef
  createdAt: string
}

export type WorkflowRejectionCode =
  | 'workflow_required'
  | 'workflow_not_found'
  | 'invalid_work_state'
  | 'idempotency_key_required'
  | 'idempotency_conflict'
  | 'task_not_found'
  | 'unknown_transition'
  | 'state_mismatch'
  | 'role_not_allowed'
  | 'role_not_bound'
  | 'authority_not_granted'
  | 'sod_violation'
  | 'missing_evidence'
  | 'invalid_evidence'
  | 'open_blocking_obligation'
  | 'obligation_not_satisfied'
  | 'waiver_required'
  | 'version_conflict'
  | 'context_stale'
  | 'capability_not_granted'
  | 'one_control_action_required'
  | 'obligation_not_found'
  | 'supervisor_paused'
  | 'supervisor_run_not_found'
  | 'evidence_not_from_participant'
  | 'evidence_not_found'

export interface WorkflowRejection {
  code: WorkflowRejectionCode
  message: string
  transitionId?: string | undefined
  missingEvidenceKinds?: string[] | undefined
  blockingObligationIds?: string[] | undefined
  suggestedActions?: string[] | undefined
}

export type WorkflowResult<T> = ({ ok: true } & T) | { ok: false; error: WorkflowRejection }

export type WorkflowControlAction =
  | { type: 'launch_participant_run'; role: string; actor: ActorRef }
  | {
      type: 'create_obligation'
      kind: string
      ownerRole?: string | undefined
      summary: string
      blocking?: boolean | undefined
    }
  | { type: 'satisfy_obligation'; obligationId: string; evidence?: EvidenceInput[] | undefined }
  | {
      type: 'waive_obligation'
      obligationId: string
      reason: string
      evidenceRefs?: string[] | undefined
    }
  | {
      type: 'propose_workflow_patch'
      category: WorkflowAnomaly['category']
      summary: string
      proposedRecovery?: string | undefined
      patchKind: WorkflowPatchProposal['patchKind']
      patch: unknown
      rationaleSummary: string
    }
  | { type: 'pause_supervision'; reason: string }
  | { type: 'unpause_supervision'; reason?: string | undefined }
  | {
      type: 'attach_evidence'
      evidence: EvidenceInput[]
    }
  | {
      type: 'apply_transition'
      transitionId: string
      evidenceRefs?: string[] | undefined
      expectedTaskVersion?: number | undefined
      participantRunId?: string | undefined
    }
  | {
      type: 'escalate'
      reason: string
      severity: string
      audience?: string | undefined
    }

export interface WorkflowIdempotencyRecord {
  fingerprint: string
  result: unknown
}

export interface WorkflowKernelSnapshot {
  definitions: PublishedWorkflowDefinition[]
  tasks: WorkflowTask[]
  evidence: EvidenceRecord[]
  obligations: ObligationRecord[]
  effects: EffectIntent[]
  events: WorkflowEvent[]
  workflowHrcRunMaps?: WorkflowHrcRunMap[] | undefined
  supervisorRuns: SupervisorRunRecord[]
  participantRuns: ParticipantRunRecord[]
  anomalies: WorkflowAnomaly[]
  patchProposals: WorkflowPatchProposal[]
  idempotency: Array<{ key: string; record: WorkflowIdempotencyRecord }>
  contextHashes: Array<{ taskId: string; hashes: string[] }>
  sequence: number
}
