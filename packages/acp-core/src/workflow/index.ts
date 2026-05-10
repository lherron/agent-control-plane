import { createHash } from 'node:crypto'

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
  state: 'pending' | 'leased' | 'delivered' | 'failed'
  createdAt: string
  updatedAt: string
}

export interface WorkflowEvent {
  eventId: string
  taskId: string
  workflow: WorkflowRef
  type: string
  actor: ActorRef
  runId?: string | undefined
  supervisorRunId?: string | undefined
  participantRunId?: string | undefined
  observedTaskVersion: number
  nextTaskVersion?: number | undefined
  contextHash?: string | undefined
  idempotencyKey: string
  payload: Record<string, unknown>
  createdAt: string
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
  supervisorRuns: SupervisorRunRecord[]
  participantRuns: ParticipantRunRecord[]
  anomalies: WorkflowAnomaly[]
  patchProposals: WorkflowPatchProposal[]
  idempotency: Array<{ key: string; record: WorkflowIdempotencyRecord }>
  contextHashes: Array<{ taskId: string; hashes: string[] }>
  sequence: number
}

const VALID_STATUSES = new Set<string>(['open', 'active', 'waiting', 'closed'])
const RISK_ORDER: Record<string, number> = { low: 1, medium: 2, high: 3 }

export function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value))
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortJson(item))
  }
  if (value === null || typeof value !== 'object') {
    return value
  }
  const source = value as Record<string, unknown>
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(source).sort()) {
    if (source[key] !== undefined) {
      sorted[key] = sortJson(source[key])
    }
  }
  return sorted
}

function hashValue(value: unknown): string {
  return `sha256:${createHash('sha256').update(stableJson(value)).digest('hex')}`
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value)
    for (const nested of Object.values(value)) {
      deepFreeze(nested)
    }
  }
  return value
}

function reject(
  code: WorkflowRejectionCode,
  message: string,
  extra: Partial<WorkflowRejection> = {}
): { ok: false; error: WorkflowRejection } {
  return { ok: false, error: { code, message, ...extra } }
}

function actorEquals(left: ActorRef | null | undefined, right: ActorRef): boolean {
  return left?.kind === right.kind && left.id === right.id
}

function validateWorkState(state: WorkState): WorkflowRejection | undefined {
  if (!VALID_STATUSES.has(state.status)) {
    return {
      code: 'invalid_work_state',
      message: `Invalid workflow status "${state.status}"`,
    }
  }
  if (state.status !== 'closed' && state.outcome !== undefined && state.outcome !== null) {
    return {
      code: 'invalid_work_state',
      message: 'Only closed work states may carry an outcome',
    }
  }
  return undefined
}

function stateMatches(state: WorkState, pattern: Partial<WorkState>): boolean {
  if (pattern.status !== undefined && state.status !== pattern.status) {
    return false
  }
  if (pattern.phase !== undefined && (state.phase ?? null) !== (pattern.phase ?? null)) {
    return false
  }
  if (pattern.outcome !== undefined && (state.outcome ?? null) !== (pattern.outcome ?? null)) {
    return false
  }
  return true
}

function applyStatePatch(state: WorkState, patch: Partial<WorkState>): WorkState {
  const next: WorkState = {
    status: patch.status ?? state.status,
    phase: patch.phase !== undefined ? patch.phase : state.phase,
  }
  if (patch.outcome !== undefined) {
    next.outcome = patch.outcome
  } else if (next.status === 'closed' && state.outcome !== undefined) {
    next.outcome = state.outcome
  }
  if (next.status !== 'closed') {
    next.outcome = undefined
  }
  return next
}

function requiredEvidenceKinds(transition: TransitionSpec): string[] {
  return (transition.requires ?? [])
    .filter(
      (requirement): requirement is Extract<Requirement, { type: 'evidence' }> =>
        requirement.type === 'evidence'
    )
    .flatMap((requirement) => requirement.kinds)
}

function getByPath(value: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((current, part) => {
    if (current !== null && typeof current === 'object') {
      return (current as Record<string, unknown>)[part]
    }
    return undefined
  }, value)
}

function makeCommand(name: string, args: Record<string, unknown>): Record<string, unknown> {
  return { name, args }
}

function contextHashFor<T extends Record<string, unknown>>(context: T): string {
  const copy: Record<string, unknown> = { ...context, contextHash: undefined }
  return hashValue(copy)
}

function getControlActionCapabilityError(
  action: WorkflowControlAction,
  capabilities: SupervisorCapabilities
): WorkflowRejection | undefined {
  const capabilityMap: Record<string, boolean | undefined> = {
    launch_participant_run: capabilities.launchRuns,
    create_obligation: capabilities.createObligations,
    satisfy_obligation: capabilities.satisfyObligations,
    waive_obligation: capabilities.createWaivers,
    propose_workflow_patch: capabilities.proposeWorkflowPatches,
    pause_supervision: capabilities.pauseSupervision,
    unpause_supervision: true,
    attach_evidence: capabilities.attachEvidence,
    apply_transition: capabilities.applySupervisorTransitions,
    escalate: capabilities.escalate,
  }

  const hasCapability = capabilityMap[action.type] ?? false

  if (hasCapability === true) {
    return undefined
  }

  return {
    code: 'capability_not_granted',
    message: `Capability not granted for action "${action.type}"`,
  }
}

export function createInMemoryWorkflowKernel(
  input: { now?: string | undefined; snapshot?: WorkflowKernelSnapshot | undefined } = {}
) {
  const now = input.now ?? new Date().toISOString()
  const definitions = new Map<string, PublishedWorkflowDefinition>()
  const tasks = new Map<string, WorkflowTask>()
  const evidence = new Map<string, EvidenceRecord[]>()
  const obligations = new Map<string, ObligationRecord[]>()
  const effects = new Map<string, EffectIntent[]>()
  const events = new Map<string, WorkflowEvent[]>()
  const supervisorRuns = new Map<string, SupervisorRunRecord[]>()
  const participantRuns = new Map<string, ParticipantRunRecord[]>()
  const anomalies = new Map<string, WorkflowAnomaly[]>()
  const patchProposals = new Map<string, WorkflowPatchProposal[]>()
  const idempotency = new Map<string, WorkflowIdempotencyRecord>()
  const currentContextHashes = new Map<string, Set<string>>()
  let sequence = 0

  const nextId = (prefix: string): string => `${prefix}_${String(++sequence).padStart(4, '0')}`
  const definitionKey = (id: string, version: number): string => `${id}@${version}`

  if (input.snapshot !== undefined) {
    for (const definition of input.snapshot.definitions) {
      definitions.set(
        definitionKey(definition.id, definition.version),
        deepFreeze(clone(definition))
      )
    }
    for (const task of input.snapshot.tasks) {
      tasks.set(task.taskId, clone(task))
    }
    for (const record of input.snapshot.evidence) {
      evidence.set(record.taskId, [...(evidence.get(record.taskId) ?? []), clone(record)])
    }
    for (const record of input.snapshot.obligations) {
      obligations.set(record.taskId, [...(obligations.get(record.taskId) ?? []), clone(record)])
    }
    for (const record of input.snapshot.effects) {
      effects.set(record.taskId, [...(effects.get(record.taskId) ?? []), clone(record)])
    }
    for (const event of input.snapshot.events) {
      events.set(event.taskId, [...(events.get(event.taskId) ?? []), clone(event)])
    }
    for (const run of input.snapshot.supervisorRuns) {
      supervisorRuns.set(run.taskId, [...(supervisorRuns.get(run.taskId) ?? []), clone(run)])
    }
    for (const run of input.snapshot.participantRuns) {
      participantRuns.set(run.taskId, [...(participantRuns.get(run.taskId) ?? []), clone(run)])
    }
    for (const anomaly of input.snapshot.anomalies) {
      anomalies.set(anomaly.taskId, [...(anomalies.get(anomaly.taskId) ?? []), clone(anomaly)])
    }
    for (const proposal of input.snapshot.patchProposals) {
      patchProposals.set(proposal.taskId, [
        ...(patchProposals.get(proposal.taskId) ?? []),
        clone(proposal),
      ])
    }
    for (const entry of input.snapshot.idempotency) {
      idempotency.set(entry.key, clone(entry.record))
    }
    for (const entry of input.snapshot.contextHashes) {
      currentContextHashes.set(entry.taskId, new Set(entry.hashes))
    }
    sequence = input.snapshot.sequence
  }

  const rememberContextHash = (taskId: string, hash: string): void => {
    currentContextHashes.set(taskId, new Set([...(currentContextHashes.get(taskId) ?? []), hash]))
  }

  const clearContextHashes = (taskId: string): void => {
    currentContextHashes.delete(taskId)
  }

  const withIdempotency = <T extends { ok: boolean }>(
    idempotencyKey: string | undefined,
    payload: unknown,
    mutator: () => T
  ): T | { ok: false; error: WorkflowRejection } => {
    if (!idempotencyKey) {
      return reject(
        'idempotency_key_required',
        'Mutating workflow commands require an idempotency key'
      )
    }
    const fingerprint = hashValue(payload)
    const existing = idempotency.get(idempotencyKey)
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        return reject(
          'idempotency_conflict',
          `Idempotency key "${idempotencyKey}" was used with a different payload`
        )
      }
      return clone(existing.result) as T
    }
    const result = mutator()
    idempotency.set(idempotencyKey, { fingerprint, result: clone(result) })
    return result
  }

  const appendEvent = (
    task: WorkflowTask,
    inputEvent: Omit<WorkflowEvent, 'eventId' | 'createdAt' | 'workflow'>
  ): WorkflowEvent => {
    const event: WorkflowEvent = {
      eventId: nextId('wevt'),
      createdAt: now,
      workflow: task.workflow,
      ...inputEvent,
    }
    events.set(task.taskId, [...(events.get(task.taskId) ?? []), clone(event)])
    return event
  }

  const addEvidence = (
    task: WorkflowTask,
    items: readonly EvidenceInput[],
    actor: ActorRef,
    idempotencyKey: string,
    observedTaskVersion: number,
    provenance?: {
      role?: string | undefined
      runId?: string | undefined
      participantRunId?: string | undefined
      supervisorRunId?: string | undefined
    }
  ): EvidenceRecord[] => {
    const records = items.map((item) => ({
      evidenceId: nextId('evd'),
      taskId: task.taskId,
      actor: clone(actor),
      ...(provenance?.role !== undefined ? { role: provenance.role } : {}),
      ...(provenance?.runId !== undefined ? { runId: provenance.runId } : {}),
      ...(provenance?.participantRunId !== undefined
        ? { participantRunId: provenance.participantRunId }
        : {}),
      ...(provenance?.supervisorRunId !== undefined
        ? { supervisorRunId: provenance.supervisorRunId }
        : {}),
      createdAt: now,
      ...clone(item),
    }))
    evidence.set(task.taskId, [...(evidence.get(task.taskId) ?? []), ...records])
    for (const record of records) {
      appendEvent(task, {
        taskId: task.taskId,
        type: 'evidence.attached',
        actor,
        ...(provenance?.runId ? { runId: provenance.runId } : {}),
        ...(provenance?.supervisorRunId ? { supervisorRunId: provenance.supervisorRunId } : {}),
        observedTaskVersion,
        idempotencyKey,
        payload: {
          evidenceId: record.evidenceId,
          kind: record.kind,
          ref: record.ref,
          ...(record.summary ? { summary: record.summary } : {}),
          actor: clone(actor),
          ...(provenance?.role !== undefined ? { role: provenance.role } : {}),
          ...(provenance?.runId !== undefined ? { runId: provenance.runId } : {}),
          ...(provenance?.supervisorRunId !== undefined
            ? { supervisorRunId: provenance.supervisorRunId }
            : {}),
        },
      })
    }
    return records
  }

  const createEffectIntent = (
    task: WorkflowTask,
    sourceEventId: string,
    idempotencyKey: string,
    kind: string,
    payload: Record<string, unknown>,
    actor: ActorRef,
    observedTaskVersion: number
  ): EffectIntent => {
    const effect: EffectIntent = {
      effectId: nextId('eff'),
      taskId: task.taskId,
      sourceEventId,
      kind,
      payload: clone(payload),
      idempotencyKey: `${idempotencyKey}:effect:${kind}:${sequence}`,
      state: 'pending',
      createdAt: now,
      updatedAt: now,
    }
    effects.set(task.taskId, [...(effects.get(task.taskId) ?? []), clone(effect)])
    appendEvent(task, {
      taskId: task.taskId,
      type: 'effect_intent.created',
      actor,
      observedTaskVersion,
      idempotencyKey,
      payload: { effectId: effect.effectId, kind, payload },
    })
    return effect
  }

  const getDefinitionForTask = (task: WorkflowTask): PublishedWorkflowDefinition => {
    const definition = definitions.get(definitionKey(task.workflow.id, task.workflow.version))
    if (definition === undefined) {
      throw new Error(
        `Workflow definition missing for ${task.workflow.id}@${task.workflow.version}`
      )
    }
    return definition
  }

  const openBlockingObligations = (taskId: string): ObligationRecord[] =>
    (obligations.get(taskId) ?? []).filter(
      (obligation) => obligation.status === 'open' && obligation.blocking
    )

  const evaluateCondition = (task: WorkflowTask, condition: BuiltInCondition): boolean => {
    switch (condition.type) {
      case 'risk_at_least':
        return (RISK_ORDER[task.risk ?? 'low'] ?? 0) >= (RISK_ORDER[condition.level] ?? 0)
      case 'risk_equals':
        return task.risk === condition.level
      case 'role_bound':
        return (
          task.roleBindings[condition.role] !== undefined &&
          task.roleBindings[condition.role] !== null
        )
      case 'fact_equals':
        return getByPath(task.facts ?? {}, condition.path) === condition.value
      case 'no_open_blocking_obligations':
        return openBlockingObligations(task.taskId).length === 0
      case 'all_child_tasks_closed':
        return true
    }
  }

  const materializeTransitionEffect = (
    task: WorkflowTask,
    transitionEvent: WorkflowEvent,
    template: EffectTemplate,
    actor: ActorRef,
    idempotencyKey: string
  ): void => {
    if ((template.when ?? []).some((condition) => !evaluateCondition(task, condition))) {
      return
    }
    if (template.type === 'declare_handoff') {
      createEffectIntent(
        task,
        transitionEvent.eventId,
        idempotencyKey,
        'declare_handoff',
        {
          toRole: template.toRole,
          kind: template.kind,
          ...(template.reason ? { reason: template.reason } : {}),
        },
        actor,
        transitionEvent.nextTaskVersion ?? task.version
      )
      return
    }
    if (template.type === 'wake_role_session') {
      createEffectIntent(
        task,
        transitionEvent.eventId,
        idempotencyKey,
        'wake_role_session',
        { role: template.role, ...(template.reason ? { reason: template.reason } : {}) },
        actor,
        transitionEvent.nextTaskVersion ?? task.version
      )
      return
    }
    if (template.type === 'create_obligation') {
      const definition = getDefinitionForTask(task)
      const spec = definition.obligationKinds?.[template.kind]
      const obligation: ObligationRecord = {
        obligationId: nextId('obl'),
        taskId: task.taskId,
        kind: template.kind,
        ...(template.ownerRole ? { ownerRole: template.ownerRole } : {}),
        summary: `Workflow effect created ${template.kind}`,
        blocking: template.blocking ?? spec?.blockingDefault ?? true,
        status: 'open',
        createdAt: now,
        updatedAt: now,
      }
      obligations.set(task.taskId, [...(obligations.get(task.taskId) ?? []), clone(obligation)])
      createEffectIntent(
        task,
        transitionEvent.eventId,
        idempotencyKey,
        'create_obligation',
        {
          obligationId: obligation.obligationId,
          kind: obligation.kind,
          ...(obligation.ownerRole ? { ownerRole: obligation.ownerRole } : {}),
          blocking: obligation.blocking,
        },
        actor,
        transitionEvent.nextTaskVersion ?? task.version
      )
      return
    }
    createEffectIntent(
      task,
      transitionEvent.eventId,
      idempotencyKey,
      template.type,
      clone(template) as Record<string, unknown>,
      actor,
      transitionEvent.nextTaskVersion ?? task.version
    )
  }

  const buildTransitionAffordance = (
    task: WorkflowTask,
    transition: TransitionSpec,
    role: string,
    reason?: WorkflowRejection | undefined
  ): Record<string, unknown> => ({
    id: transition.id,
    ...(transition.label ? { label: transition.label } : {}),
    to: transition.to,
    requiredEvidence: requiredEvidenceKinds(transition).map((kind) => ({ kind })),
    effectsPreview: (transition.effects ?? []).map((effect) => ({ type: effect.type })),
    command: makeCommand('acp.workflow.applyTransition', {
      taskId: task.taskId,
      transitionId: transition.id,
      role,
      expectedTaskVersion: task.version,
      idempotencyKey: `IDEMPOTENCY_PREFIX:transition:${transition.id}:v${task.version}`,
    }),
    ...(reason ? { rejection: reason } : {}),
  })

  const evaluateTransition = (
    task: WorkflowTask,
    transition: TransitionSpec,
    actor: ActorRef,
    role: string,
    allEvidence: readonly EvidenceInput[],
    waiverRefs: readonly string[] = []
  ): WorkflowRejection | undefined => {
    if (!stateMatches(task.state, transition.from)) {
      return {
        code: 'state_mismatch',
        message: `Transition "${transition.id}" is not legal from the current state`,
        transitionId: transition.id,
      }
    }
    if (!(transition.by ?? []).includes(role)) {
      return {
        code: 'role_not_allowed',
        message: `Role "${role}" is not allowed to apply transition "${transition.id}"`,
        transitionId: transition.id,
      }
    }
    const definition = getDefinitionForTask(task)
    if (definition.roles[role] === undefined) {
      return {
        code: 'role_not_allowed',
        message: `Role "${role}" is not defined by workflow "${definition.id}"`,
        transitionId: transition.id,
      }
    }
    const boundActor = task.roleBindings[role]
    if (boundActor === undefined || boundActor === null) {
      if (definition.roles[role]?.binding !== 'autoBindOnFirstRun') {
        return {
          code: 'role_not_bound',
          message: `Role "${role}" is not bound to the acting actor`,
          transitionId: transition.id,
        }
      }
    } else if (!actorEquals(boundActor, actor)) {
      return {
        code: 'role_not_bound',
        message: `Role "${role}" is bound to a different actor`,
        transitionId: transition.id,
      }
    }
    const blocking = openBlockingObligations(task.taskId)
    const hasObligationRequirement = (transition.requires ?? []).some(
      (requirement) => requirement.type === 'obligation_satisfied'
    )
    if (blocking.length > 0 && !hasObligationRequirement) {
      return {
        code: 'open_blocking_obligation',
        message: 'Open blocking obligations prevent this transition',
        transitionId: transition.id,
        blockingObligationIds: blocking.map((obligation) => obligation.obligationId),
        suggestedActions: ['satisfy_obligation'],
      }
    }
    for (const requirement of transition.requires ?? []) {
      if (requirement.type === 'evidence') {
        const present = new Set(allEvidence.map((item) => item.kind))
        const missing = requirement.kinds.filter((kind) => !present.has(kind))
        const satisfied =
          requirement.mode === 'any'
            ? missing.length < requirement.kinds.length
            : missing.length === 0
        if (!satisfied) {
          return {
            code: 'missing_evidence',
            message: `Missing required evidence for transition "${transition.id}"`,
            transitionId: transition.id,
            missingEvidenceKinds: requirement.mode === 'any' ? requirement.kinds : missing,
            suggestedActions: ['attach_evidence', 'launch_participant_run'],
          }
        }
      }
      if (requirement.type === 'sod') {
        const actingActor = task.roleBindings[requirement.actingRole] ?? actor
        const conflict = requirement.notSameAs.find((otherRole) =>
          actorEquals(task.roleBindings[otherRole], actingActor)
        )
        if (conflict !== undefined) {
          return {
            code: 'sod_violation',
            message: `Role "${requirement.actingRole}" must differ from "${conflict}"`,
            transitionId: transition.id,
          }
        }
      }
      if (requirement.type === 'obligation_satisfied') {
        const matches = (obligations.get(task.taskId) ?? []).filter((obligation) => {
          if (requirement.obligationId !== undefined) {
            return obligation.obligationId === requirement.obligationId
          }
          if (requirement.kind !== undefined) {
            return obligation.kind === requirement.kind
          }
          return true
        })
        if (
          matches.length === 0 ||
          matches.some((obligation) => obligation.status !== 'satisfied')
        ) {
          return {
            code: 'obligation_not_satisfied',
            message: `Transition "${transition.id}" requires a satisfied obligation`,
            transitionId: transition.id,
          }
        }
      }
      if (requirement.type === 'waiver') {
        const refs = new Set(waiverRefs)
        const matchingWaiver = (obligations.get(task.taskId) ?? []).find(
          (obligation) =>
            refs.has(obligation.obligationId) &&
            obligation.kind === requirement.waiverKind &&
            obligation.status === 'waived'
        )
        if (matchingWaiver === undefined) {
          return {
            code: 'waiver_required',
            message: `Transition "${transition.id}" requires a recorded waiver for "${requirement.waiverKind}"`,
            transitionId: transition.id,
            suggestedActions: ['waive_obligation'],
          }
        }
      }
    }
    return undefined
  }

  const findObligation = (
    obligationId: string
  ): {
    task: WorkflowTask
    list: ObligationRecord[]
    index: number
    obligation: ObligationRecord
  } => {
    for (const [taskId, list] of obligations.entries()) {
      const index = list.findIndex((obligation) => obligation.obligationId === obligationId)
      if (index < 0) {
        continue
      }
      const task = tasks.get(taskId)
      const obligation = list[index]
      if (task !== undefined && obligation !== undefined) {
        return { task, list, index, obligation }
      }
    }
    throw new Error(`Obligation not found: ${obligationId}`)
  }

  const resolveObligation = (
    obligationId: string
  ): WorkflowResult<{
    task: WorkflowTask
    list: ObligationRecord[]
    index: number
    obligation: ObligationRecord
  }> => {
    try {
      return { ok: true, ...findObligation(obligationId) }
    } catch {
      return reject('obligation_not_found', `Obligation not found: ${obligationId}`)
    }
  }

  const hasObligationLifecycleAuthority = (
    task: WorkflowTask,
    obligation: ObligationRecord,
    actor: ActorRef
  ): boolean => {
    const supervisor = task.supervisor
    if (
      supervisor !== undefined &&
      actorEquals(supervisor.actor, actor) &&
      (supervisor.capabilities.createWaivers === true ||
        supervisor.capabilities.createObligations === true)
    ) {
      return true
    }

    const definition = getDefinitionForTask(task)
    const ownerRoles = definition.obligationKinds?.[obligation.kind]?.ownerRoles ?? []
    const roles =
      ownerRoles.length > 0 ? ownerRoles : obligation.ownerRole ? [obligation.ownerRole] : []
    return roles.some((role) => actorEquals(task.roleBindings[role], actor))
  }

  const nextTaskAfterObligationClosed = (
    task: WorkflowTask,
    nextObligations: readonly ObligationRecord[]
  ): WorkflowTask => {
    const stillBlocked = nextObligations.some(
      (obligation) => obligation.status === 'open' && obligation.blocking
    )
    const definition = getDefinitionForTask(task)
    const hasWaitingResumeTransition = Object.values(definition.transitions).some((transition) =>
      stateMatches(task.state, transition.from)
    )
    return {
      ...task,
      state:
        stillBlocked || (task.state.status === 'waiting' && hasWaitingResumeTransition)
          ? task.state
          : task.state.status === 'waiting'
            ? { status: 'active', phase: task.state.phase }
            : task.state,
      version: task.version + 1,
      updatedAt: now,
    }
  }

  const publishWorkflowDefinition = (
    definition: WorkflowDefinition
  ): PublishedWorkflowDefinition => {
    const validation = validateWorkState(definition.initial)
    if (validation !== undefined) {
      throw new Error(validation.message)
    }
    for (const transition of Object.values(definition.transitions)) {
      const toValidation = validateWorkState(applyStatePatch(definition.initial, transition.to))
      if (toValidation !== undefined) {
        throw new Error(toValidation.message)
      }
    }
    const definitionForHash = clone(definition)
    definitionForHash.hash = undefined
    const hash = definition.hash ?? hashValue(definitionForHash)
    const published = deepFreeze({
      ...clone(definition),
      hash,
      workflow: { id: definition.id, version: definition.version, hash },
    })
    definitions.set(definitionKey(definition.id, definition.version), published)
    return published
  }

  const getWorkflowDefinition = (
    id: string,
    version: number
  ): PublishedWorkflowDefinition | undefined => definitions.get(definitionKey(id, version))

  const resolveWorkflowForCreate = (
    workflow: { id: string; version: number } | { definition: WorkflowDefinition } | undefined
  ): WorkflowResult<{ definition: PublishedWorkflowDefinition }> => {
    if (workflow === undefined) {
      return reject('workflow_required', 'Durable workflow tasks require a workflow definition')
    }
    if ('definition' in workflow) {
      const validation = validateWorkState(workflow.definition.initial)
      if (validation !== undefined) {
        return { ok: false, error: validation }
      }
      return { ok: true, definition: publishWorkflowDefinition(workflow.definition) }
    }
    const definition = getWorkflowDefinition(workflow.id, workflow.version)
    if (definition === undefined) {
      return reject(
        'workflow_not_found',
        `Workflow "${workflow.id}@${workflow.version}" is not published`
      )
    }
    return { ok: true, definition }
  }

  const createTask = (request: {
    taskId: string
    projectId: string
    workflow?: { id: string; version: number } | { definition: WorkflowDefinition } | undefined
    goal: string
    risk?: string | undefined
    initialFacts?: Record<string, unknown> | undefined
    roleBindings?: RoleBindings | undefined
    supervisor?: SupervisorBinding | undefined
    idempotencyKey?: string | undefined
  }): WorkflowResult<{ task: WorkflowTask }> =>
    withIdempotency(request.idempotencyKey, request, () => {
      const idempotencyKey = request.idempotencyKey ?? ''
      const resolved = resolveWorkflowForCreate(request.workflow)
      if (!resolved.ok) {
        return resolved
      }
      const task: WorkflowTask = {
        taskId: request.taskId,
        projectId: request.projectId,
        workflow: resolved.definition.workflow,
        state: clone(resolved.definition.initial),
        version: 0,
        goal: request.goal,
        ...(request.risk ? { risk: request.risk } : {}),
        ...(request.initialFacts ? { facts: clone(request.initialFacts) } : {}),
        roleBindings: clone(request.roleBindings ?? {}),
        ...(request.supervisor ? { supervisor: clone(request.supervisor) } : {}),
        createdAt: now,
        updatedAt: now,
      }
      tasks.set(task.taskId, clone(task))
      evidence.set(task.taskId, [])
      obligations.set(task.taskId, [])
      effects.set(task.taskId, [])
      events.set(task.taskId, [])
      supervisorRuns.set(task.taskId, [])
      participantRuns.set(task.taskId, [])
      anomalies.set(task.taskId, [])
      patchProposals.set(task.taskId, [])
      appendEvent(task, {
        taskId: task.taskId,
        type: 'task.created',
        actor: request.supervisor?.actor ?? { kind: 'service', id: 'workflow-kernel' },
        observedTaskVersion: 0,
        nextTaskVersion: 0,
        idempotencyKey,
        payload: {
          goal: task.goal,
          state: task.state,
          roleBindings: task.roleBindings,
        },
      })
      return { ok: true, task: clone(task) }
    })

  const startSupervisorRun = (request: {
    taskId: string
    runId?: string | undefined
    supervisor: ActorRef
    autonomy: SupervisorBinding['autonomy']
    capabilities?: SupervisorCapabilities | undefined
    harness?: Record<string, unknown> | undefined
    idempotencyKey?: string | undefined
  }): WorkflowResult<{
    task: WorkflowTask
    supervisorRun: SupervisorRunRecord
    context: Record<string, unknown>
  }> =>
    withIdempotency(request.idempotencyKey, request, () => {
      const idempotencyKey = request.idempotencyKey ?? ''
      const task = tasks.get(request.taskId)
      if (task === undefined) {
        return reject('task_not_found', `Task not found: ${request.taskId}`)
      }
      const runId = request.runId ?? nextId('supv')
      const capabilities = request.capabilities ?? task.supervisor?.capabilities ?? {}
      const context = compileSupervisorContext({
        taskId: task.taskId,
        runId,
        actor: request.supervisor,
        autonomy: request.autonomy,
        capabilities,
        idempotencyPrefix: idempotencyKey,
      })
      const supervisorRun: SupervisorRunRecord = {
        runId,
        kind: 'workflow_supervisor',
        taskId: task.taskId,
        workflow: task.workflow,
        supervisor: clone(request.supervisor),
        autonomy: request.autonomy,
        capabilities: clone(capabilities),
        ...(request.harness !== undefined ? { harness: clone(request.harness) } : {}),
        taskVersionAtStart: task.version,
        contextHash: String(context['contextHash']),
        createdAt: now,
      }
      supervisorRuns.set(task.taskId, [
        ...(supervisorRuns.get(task.taskId) ?? []),
        clone(supervisorRun),
      ])
      appendEvent(task, {
        taskId: task.taskId,
        type: 'supervisor_run.started',
        actor: request.supervisor,
        supervisorRunId: runId,
        observedTaskVersion: task.version,
        idempotencyKey,
        payload: {
          runId,
          autonomy: request.autonomy,
          capabilities,
          contextHash: supervisorRun.contextHash,
          ...(request.harness !== undefined ? { harness: request.harness } : {}),
        },
      })
      return {
        ok: true,
        task: clone(task),
        supervisorRun: clone(supervisorRun),
        context: clone(context),
      }
    })

  const applyTransition = (request: {
    taskId: string
    transitionId: string
    actor: ActorRef
    role: string
    expectedTaskVersion: number
    contextHash?: string | undefined
    evidenceRefs?: string[] | undefined
    inlineEvidence?: EvidenceInput[] | undefined
    waiverRefs?: string[] | undefined
    runId?: string | undefined
    idempotencyKey?: string | undefined
  }): WorkflowResult<{ task: WorkflowTask; event: WorkflowEvent; effects: EffectIntent[] }> =>
    withIdempotency(request.idempotencyKey, request, () => {
      const idempotencyKey = request.idempotencyKey ?? ''
      const task = tasks.get(request.taskId)
      if (task === undefined) {
        return reject('task_not_found', `Task not found: ${request.taskId}`)
      }
      if (request.expectedTaskVersion !== task.version) {
        return reject(
          'version_conflict',
          `Task version ${task.version} does not match expected version ${request.expectedTaskVersion}`
        )
      }
      if (
        request.contextHash !== undefined &&
        currentContextHashes.get(task.taskId)?.has(request.contextHash) !== true
      ) {
        return reject('context_stale', 'The supplied context hash is not current for this task')
      }
      const definition = getDefinitionForTask(task)
      const transition = definition.transitions[request.transitionId]
      if (transition === undefined) {
        return reject('unknown_transition', `Unknown transition "${request.transitionId}"`, {
          transitionId: request.transitionId,
        })
      }
      const combinedEvidence = [
        ...(evidence.get(task.taskId) ?? []),
        ...(request.inlineEvidence ?? []),
      ]
      const transitionError = evaluateTransition(
        task,
        transition,
        request.actor,
        request.role,
        combinedEvidence,
        request.waiverRefs
      )
      if (transitionError !== undefined) {
        return { ok: false, error: transitionError }
      }
      const roleSpec = definition.roles[request.role]
      if (
        (task.roleBindings[request.role] === undefined ||
          task.roleBindings[request.role] === null) &&
        roleSpec?.binding === 'autoBindOnFirstRun'
      ) {
        task.roleBindings[request.role] = clone(request.actor)
      }
      if ((request.inlineEvidence ?? []).length > 0) {
        addEvidence(
          task,
          request.inlineEvidence ?? [],
          request.actor,
          idempotencyKey,
          task.version,
          {
            role: request.role,
            runId: request.runId,
          }
        )
      }
      const previousVersion = task.version
      const nextTask: WorkflowTask = {
        ...task,
        state: applyStatePatch(task.state, transition.to),
        version: task.version + 1,
        updatedAt: now,
      }
      const validation = validateWorkState(nextTask.state)
      if (validation !== undefined) {
        return { ok: false, error: validation }
      }
      tasks.set(task.taskId, clone(nextTask))
      clearContextHashes(task.taskId)
      const event = appendEvent(nextTask, {
        taskId: task.taskId,
        type: 'transition.applied',
        actor: request.actor,
        ...(request.runId ? { runId: request.runId } : {}),
        observedTaskVersion: previousVersion,
        nextTaskVersion: nextTask.version,
        ...(request.contextHash ? { contextHash: request.contextHash } : {}),
        idempotencyKey,
        payload: {
          transitionId: request.transitionId,
          role: request.role,
          from: task.state,
          to: nextTask.state,
          evidenceKinds: (request.inlineEvidence ?? []).map((item) => item.kind),
          ...(request.evidenceRefs !== undefined ? { evidenceRefs: request.evidenceRefs } : {}),
          ...(request.waiverRefs !== undefined ? { waiverRefs: request.waiverRefs } : {}),
        },
      })
      const beforeEffectCount = effects.get(task.taskId)?.length ?? 0
      for (const effect of transition.effects ?? []) {
        materializeTransitionEffect(nextTask, event, effect, request.actor, idempotencyKey)
      }
      return {
        ok: true,
        task: clone(nextTask),
        event: clone(event),
        effects: clone((effects.get(task.taskId) ?? []).slice(beforeEffectCount)),
      }
    })

  const submitControlAction = (request: {
    taskId: string
    supervisorRunId: string
    actor?: ActorRef | undefined
    contextHash?: string | undefined
    expectedTaskVersion?: number | undefined
    capabilities?: SupervisorCapabilities | undefined
    action: WorkflowControlAction | WorkflowControlAction[]
    idempotencyKey?: string | undefined
  }): WorkflowResult<{
    task: WorkflowTask
    obligation?: ObligationRecord | undefined
    participantRun?: ParticipantRunRecord | undefined
    anomaly?: WorkflowAnomaly | undefined
    proposal?: WorkflowPatchProposal | undefined
    evidence?: EvidenceRecord[] | undefined
  }> =>
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: central dispatcher for one checked supervisor action.
    withIdempotency(request.idempotencyKey, request, () => {
      const idempotencyKey = request.idempotencyKey ?? ''
      const task = tasks.get(request.taskId)
      if (task === undefined) {
        return reject('task_not_found', `Task not found: ${request.taskId}`)
      }
      if (Array.isArray(request.action)) {
        return reject(
          'one_control_action_required',
          'Submit exactly one workflow control action at a time'
        )
      }
      if (
        request.expectedTaskVersion !== undefined &&
        request.expectedTaskVersion !== task.version
      ) {
        return reject(
          'version_conflict',
          `Task version ${task.version} does not match expected version ${request.expectedTaskVersion}`
        )
      }
      if (
        request.contextHash !== undefined &&
        currentContextHashes.get(task.taskId)?.has(request.contextHash) !== true
      ) {
        return reject('context_stale', 'The supplied context hash is not current for this task')
      }
      // Authorization hardening: load persisted supervisor run record
      const supervisorRunList = supervisorRuns.get(task.taskId) ?? []
      const supervisorRun = supervisorRunList.find((run) => run.runId === request.supervisorRunId)
      if (supervisorRun === undefined) {
        return reject(
          'authority_not_granted',
          `Supervisor run "${request.supervisorRunId}" not found on task "${task.taskId}"`
        )
      }
      // Verify request actor matches supervisor run actor
      if (request.actor !== undefined && !actorEquals(request.actor, supervisorRun.supervisor)) {
        return reject('authority_not_granted', 'Request actor does not match supervisor run actor')
      }
      // Verify supervisor run actor matches task supervisor binding
      if (
        task.supervisor !== undefined &&
        !actorEquals(task.supervisor.actor, supervisorRun.supervisor)
      ) {
        return reject(
          'authority_not_granted',
          'Supervisor run actor does not match task supervisor binding'
        )
      }
      // Derive capabilities from persisted supervisor run record, NOT from request body
      const capabilities = supervisorRun.capabilities
      const action = request.action
      // Check if supervisor run is paused (unpause is always allowed when paused)
      if (supervisorRun.paused === true && action.type !== 'unpause_supervision') {
        return reject(
          'supervisor_paused',
          'Supervisor run is paused — only unpause_supervision is allowed'
        )
      }
      const capabilityError = getControlActionCapabilityError(action, capabilities)
      if (capabilityError !== undefined) {
        return { ok: false, error: capabilityError }
      }
      if (action.type === 'launch_participant_run') {
        const run: ParticipantRunRecord = {
          runId: nextId('run'),
          kind: 'participant',
          taskId: task.taskId,
          workflow: task.workflow,
          actor: clone(action.actor),
          role: action.role,
          status: 'launched',
          parentSupervisorRunId: request.supervisorRunId,
          taskVersionAtStart: task.version,
          contextHash: hashValue({
            taskId: task.taskId,
            role: action.role,
            actor: action.actor,
            version: task.version,
          }),
          createdAt: now,
        }
        participantRuns.set(task.taskId, [...(participantRuns.get(task.taskId) ?? []), clone(run)])
        const event = appendEvent(task, {
          taskId: task.taskId,
          type: 'participant_run.launched',
          actor: task.supervisor?.actor ?? { kind: 'agent', id: request.supervisorRunId },
          supervisorRunId: request.supervisorRunId,
          observedTaskVersion: task.version,
          idempotencyKey,
          payload: { runId: run.runId, role: run.role, actor: run.actor },
        })
        createEffectIntent(
          task,
          event.eventId,
          idempotencyKey,
          'wake_role_session',
          {
            role: action.role,
            actor: action.actor,
            runId: run.runId,
            reason: `Workflow supervisor launched ${action.role} for ${task.taskId}`,
          },
          task.supervisor?.actor ?? { kind: 'agent', id: request.supervisorRunId },
          task.version
        )
        return { ok: true, task: clone(task), participantRun: clone(run) }
      }
      if (action.type === 'create_obligation') {
        const definition = getDefinitionForTask(task)
        const spec = definition.obligationKinds?.[action.kind]
        const obligation: ObligationRecord = {
          obligationId: nextId('obl'),
          taskId: task.taskId,
          kind: action.kind,
          ...(action.ownerRole ? { ownerRole: action.ownerRole } : {}),
          summary: action.summary,
          blocking: action.blocking ?? spec?.blockingDefault ?? true,
          status: 'open',
          createdAt: now,
          updatedAt: now,
        }
        obligations.set(task.taskId, [...(obligations.get(task.taskId) ?? []), clone(obligation)])
        const nextTask: WorkflowTask = obligation.blocking
          ? {
              ...task,
              state: { status: 'waiting', phase: task.state.phase },
              version: task.version + 1,
              updatedAt: now,
            }
          : { ...task, version: task.version + 1, updatedAt: now }
        tasks.set(task.taskId, clone(nextTask))
        clearContextHashes(task.taskId)
        appendEvent(nextTask, {
          taskId: task.taskId,
          type: 'obligation.created',
          actor: task.supervisor?.actor ?? { kind: 'agent', id: request.supervisorRunId },
          supervisorRunId: request.supervisorRunId,
          observedTaskVersion: task.version,
          nextTaskVersion: nextTask.version,
          idempotencyKey,
          payload: clone(obligation) as unknown as Record<string, unknown>,
        })
        return { ok: true, task: clone(nextTask), obligation: clone(obligation) }
      }
      if (action.type === 'satisfy_obligation') {
        const list = obligations.get(task.taskId) ?? []
        const index = list.findIndex(
          (obligation) => obligation.obligationId === action.obligationId
        )
        if (index < 0) {
          return reject('obligation_not_found', `Obligation not found: ${action.obligationId}`)
        }
        const addedEvidence = action.evidence?.length
          ? addEvidence(
              task,
              action.evidence,
              task.supervisor?.actor ?? { kind: 'agent', id: request.supervisorRunId },
              idempotencyKey,
              task.version
            )
          : []
        const existingObligation = list[index]
        if (existingObligation === undefined) {
          return reject('obligation_not_found', `Obligation not found: ${action.obligationId}`)
        }
        const updatedObligation: ObligationRecord = {
          ...existingObligation,
          status: 'satisfied',
          updatedAt: now,
          satisfiedAt: now,
          satisfactionEvidenceIds: addedEvidence.map((item) => item.evidenceId),
        }
        const nextObligations = [...list]
        nextObligations[index] = updatedObligation
        obligations.set(task.taskId, clone(nextObligations))
        const stillBlocked = nextObligations.some(
          (obligation) => obligation.status === 'open' && obligation.blocking
        )
        const definition = getDefinitionForTask(task)
        const hasWaitingResumeTransition = Object.values(definition.transitions).some(
          (transition) => stateMatches(task.state, transition.from)
        )
        const nextTask: WorkflowTask = {
          ...task,
          state:
            stillBlocked || (task.state.status === 'waiting' && hasWaitingResumeTransition)
              ? task.state
              : { status: 'active', phase: task.state.phase },
          version: task.version + 1,
          updatedAt: now,
        }
        tasks.set(task.taskId, clone(nextTask))
        clearContextHashes(task.taskId)
        appendEvent(nextTask, {
          taskId: task.taskId,
          type: 'obligation.satisfied',
          actor: task.supervisor?.actor ?? { kind: 'agent', id: request.supervisorRunId },
          supervisorRunId: request.supervisorRunId,
          observedTaskVersion: task.version,
          nextTaskVersion: nextTask.version,
          idempotencyKey,
          payload: {
            obligationId: updatedObligation.obligationId,
            evidenceIds: updatedObligation.satisfactionEvidenceIds ?? [],
          },
        })
        return { ok: true, task: clone(nextTask), obligation: clone(updatedObligation) }
      }
      if (action.type === 'waive_obligation') {
        const resolved = resolveObligation(action.obligationId)
        if (!resolved.ok) {
          return resolved
        }
        if (resolved.task.taskId !== task.taskId) {
          return reject(
            'authority_not_granted',
            `Obligation ${action.obligationId} does not belong to this task`
          )
        }
        const { list, index, obligation } = resolved
        const updatedObligation: ObligationRecord = {
          ...obligation,
          status: 'waived',
          updatedAt: now,
          waivedAt: now,
          waiverReason: action.reason,
          ...(action.evidenceRefs !== undefined
            ? { waiverEvidenceRefs: clone(action.evidenceRefs) }
            : {}),
        }
        const nextObligations = [...list]
        nextObligations[index] = updatedObligation
        obligations.set(task.taskId, clone(nextObligations))
        const nextTask = nextTaskAfterObligationClosed(task, nextObligations)
        tasks.set(task.taskId, clone(nextTask))
        clearContextHashes(task.taskId)
        appendEvent(nextTask, {
          taskId: task.taskId,
          type: 'waiver.recorded',
          actor: supervisorRun.supervisor,
          supervisorRunId: request.supervisorRunId,
          observedTaskVersion: task.version,
          nextTaskVersion: nextTask.version,
          idempotencyKey,
          payload: {
            obligationId: action.obligationId,
            waiverKind: obligation.kind,
            reason: action.reason,
            evidenceRefs: action.evidenceRefs ?? [],
          },
        })
        appendEvent(nextTask, {
          taskId: task.taskId,
          type: 'obligation.waived',
          actor: supervisorRun.supervisor,
          supervisorRunId: request.supervisorRunId,
          observedTaskVersion: task.version,
          nextTaskVersion: nextTask.version,
          idempotencyKey,
          payload: {
            obligationId: action.obligationId,
            kind: obligation.kind,
            reason: action.reason,
            evidenceRefs: action.evidenceRefs ?? [],
          },
        })
        return { ok: true, task: clone(nextTask), obligation: clone(updatedObligation) }
      }
      if (action.type === 'propose_workflow_patch') {
        const anomaly: WorkflowAnomaly = {
          anomalyId: nextId('anom'),
          taskId: task.taskId,
          workflow: task.workflow,
          supervisorRunId: request.supervisorRunId,
          category: action.category,
          stateAtObservation: clone(task.state),
          taskVersion: task.version,
          summary: action.summary,
          ...(action.proposedRecovery ? { proposedRecovery: action.proposedRecovery } : {}),
          createdAt: now,
        }
        anomalies.set(task.taskId, [...(anomalies.get(task.taskId) ?? []), clone(anomaly)])
        const proposal: WorkflowPatchProposal = {
          proposalId: nextId('wpp'),
          taskId: task.taskId,
          baseWorkflow: task.workflow,
          sourceAnomalyIds: [anomaly.anomalyId],
          patchKind: action.patchKind,
          patch: clone(action.patch),
          rationaleSummary: action.rationaleSummary,
          status: 'proposed',
          createdBy: task.supervisor?.actor ?? { kind: 'agent', id: request.supervisorRunId },
          createdAt: now,
        }
        patchProposals.set(task.taskId, [
          ...(patchProposals.get(task.taskId) ?? []),
          clone(proposal),
        ])
        appendEvent(task, {
          taskId: task.taskId,
          type: 'workflow_patch.proposed',
          actor: proposal.createdBy,
          supervisorRunId: request.supervisorRunId,
          observedTaskVersion: task.version,
          idempotencyKey,
          payload: {
            anomalyId: anomaly.anomalyId,
            proposalId: proposal.proposalId,
            patchKind: proposal.patchKind,
          },
        })
        return { ok: true, task: clone(task), anomaly: clone(anomaly), proposal: clone(proposal) }
      }
      if (action.type === 'pause_supervision') {
        // Update persisted supervisor run record
        const runIdx = supervisorRunList.findIndex((run) => run.runId === request.supervisorRunId)
        if (runIdx >= 0) {
          const updatedRun: SupervisorRunRecord = {
            ...supervisorRun,
            paused: true,
            pausedReason: action.reason,
          }
          supervisorRunList[runIdx] = clone(updatedRun)
          supervisorRuns.set(task.taskId, [...supervisorRunList])
        }
        appendEvent(task, {
          taskId: task.taskId,
          type: 'supervisor.paused',
          actor: supervisorRun.supervisor,
          supervisorRunId: request.supervisorRunId,
          observedTaskVersion: task.version,
          idempotencyKey,
          payload: { reason: action.reason, supervisorRunId: request.supervisorRunId },
        })
        return { ok: true, task: clone(task) }
      }
      if (action.type === 'unpause_supervision') {
        if (supervisorRun.paused !== true) {
          return reject('state_mismatch', 'Supervisor run is not paused')
        }
        const runIdx = supervisorRunList.findIndex((run) => run.runId === request.supervisorRunId)
        if (runIdx >= 0) {
          const updatedRun: SupervisorRunRecord = {
            ...supervisorRun,
            paused: false,
            pausedReason: undefined,
          }
          supervisorRunList[runIdx] = clone(updatedRun)
          supervisorRuns.set(task.taskId, [...supervisorRunList])
        }
        appendEvent(task, {
          taskId: task.taskId,
          type: 'supervisor.unpaused',
          actor: supervisorRun.supervisor,
          supervisorRunId: request.supervisorRunId,
          observedTaskVersion: task.version,
          idempotencyKey,
          payload: { supervisorRunId: request.supervisorRunId },
        })
        return { ok: true, task: clone(task) }
      }
      if (action.type === 'attach_evidence') {
        // Calls the same evidence kernel path as standalone attach
        const records = addEvidence(
          task,
          action.evidence,
          supervisorRun.supervisor,
          idempotencyKey,
          task.version,
          { supervisorRunId: request.supervisorRunId }
        )
        return { ok: true, task: clone(task), evidence: records.map((r) => clone(r)) }
      }
      if (action.type === 'apply_transition') {
        const definition = getDefinitionForTask(task)
        const transition = definition.transitions[action.transitionId]
        if (transition === undefined) {
          return reject('unknown_transition', `Unknown transition "${action.transitionId}"`, {
            transitionId: action.transitionId,
          })
        }
        // Reject if caller explicitly requests role='supervisor' (or any role not in by[])
        const requestedRole = (action as Record<string, unknown>)['role'] as string | undefined
        if (requestedRole !== undefined && !(transition.by ?? []).includes(requestedRole)) {
          return reject(
            'role_not_allowed',
            `Role "${requestedRole}" is not allowed to apply transition "${action.transitionId}"`,
            { transitionId: action.transitionId }
          )
        }
        // Validate expectedTaskVersion if provided
        if (
          action.expectedTaskVersion !== undefined &&
          action.expectedTaskVersion !== task.version
        ) {
          return reject(
            'version_conflict',
            `Task version ${task.version} does not match expected version ${action.expectedTaskVersion}`
          )
        }
        // Validate evidence refs - REQUIRED, must not be empty
        if ((action.evidenceRefs ?? []).length === 0) {
          return reject(
            'missing_evidence',
            `Transition "${action.transitionId}" requires evidence references`
          )
        }
        const taskEvidence = evidence.get(task.taskId) ?? []
        const referencedEvidence: EvidenceRecord[] = []
        for (const ref of action.evidenceRefs ?? []) {
          const record = taskEvidence.find((e) => e.evidenceId === ref)
          if (record === undefined) {
            return reject('evidence_not_found', `Evidence not found: ${ref}`)
          }
          if (record.taskId !== task.taskId) {
            return reject('evidence_not_found', `Evidence ${ref} does not belong to this task`)
          }
          // Evidence must be attached by a participant run, not just by the supervisor
          if (record.participantRunId === undefined) {
            return reject(
              'authority_not_granted',
              `Evidence ${ref} was not attached by a participant run — supervisor cannot use supervisor-only evidence for transitions`
            )
          }
          referencedEvidence.push(record)
        }
        // Derive role and actor from the referenced evidence's participant runs
        const participantRunIds = new Set(
          referencedEvidence.map((e) => e.participantRunId).filter((id): id is string => !!id)
        )
        const taskParticipantRuns = participantRuns.get(task.taskId) ?? []
        let derivedRole: string | undefined
        let derivedActor: ActorRef | undefined
        for (const prunId of participantRunIds) {
          const prun = taskParticipantRuns.find((r) => r.runId === prunId)
          if (prun === undefined) {
            return reject(
              'authority_not_granted',
              `Participant run ${prunId} not found on this task`
            )
          }
          // Verify participant run's role is in the transition's by[] roles
          if (!(transition.by ?? []).includes(prun.role)) {
            return reject(
              'role_not_allowed',
              `Participant run ${prunId} role "${prun.role}" is not allowed for transition "${action.transitionId}"`,
              { transitionId: action.transitionId }
            )
          }
          // Verify participant run's actor is currently bound to that role
          const boundActor = task.roleBindings[prun.role]
          if (
            boundActor === undefined ||
            boundActor === null ||
            !actorEquals(boundActor, prun.actor)
          ) {
            return reject(
              'authority_not_granted',
              `Participant run ${prunId} actor is not the current binding for role "${prun.role}"`,
              { transitionId: action.transitionId }
            )
          }
          // Validate optional participantRunId matches
          if (action.participantRunId !== undefined && action.participantRunId !== prunId) {
            return reject(
              'authority_not_granted',
              `Evidence references participant run ${prunId} but expected ${action.participantRunId}`
            )
          }
          derivedRole = prun.role
          derivedActor = prun.actor
        }
        if (derivedRole === undefined || derivedActor === undefined) {
          return reject(
            'missing_evidence',
            'Cannot derive role/actor — no participant run evidence provided'
          )
        }
        // SoD checks
        const allEvidence = [...taskEvidence]
        const transitionError = evaluateTransition(
          task,
          transition,
          derivedActor,
          derivedRole,
          allEvidence
        )
        // Allow state_mismatch and evidence errors to pass through, but check SoD
        if (transitionError !== undefined) {
          if (transitionError.code === 'sod_violation') {
            return { ok: false, error: transitionError }
          }
          if (transitionError.code === 'state_mismatch') {
            return { ok: false, error: transitionError }
          }
          if (transitionError.code === 'open_blocking_obligation') {
            return { ok: false, error: transitionError }
          }
          // For missing_evidence, we check against the referenced evidence
          if (transitionError.code === 'missing_evidence') {
            // Re-evaluate with full task evidence (referenced evidence should already be in task)
            // The transition requires evidence kinds, check they exist in task
            return { ok: false, error: transitionError }
          }
          if (
            transitionError.code !== 'role_not_allowed' &&
            transitionError.code !== 'role_not_bound'
          ) {
            return { ok: false, error: transitionError }
          }
          // role_not_allowed and role_not_bound are handled above via participant run validation
        }
        // Apply the transition
        const previousVersion = task.version
        const nextTask: WorkflowTask = {
          ...task,
          state: applyStatePatch(task.state, transition.to),
          version: task.version + 1,
          updatedAt: now,
        }
        const validation = validateWorkState(nextTask.state)
        if (validation !== undefined) {
          return { ok: false, error: validation }
        }
        tasks.set(task.taskId, clone(nextTask))
        clearContextHashes(task.taskId)
        const event = appendEvent(nextTask, {
          taskId: task.taskId,
          type: 'transition.applied',
          actor: derivedActor,
          supervisorRunId: request.supervisorRunId,
          observedTaskVersion: previousVersion,
          nextTaskVersion: nextTask.version,
          idempotencyKey,
          payload: {
            transitionId: action.transitionId,
            role: derivedRole,
            from: task.state,
            to: nextTask.state,
            authority: 'supervisor_from_participant_evidence',
            evidenceRefs: action.evidenceRefs,
            supervisorRunId: request.supervisorRunId,
          },
        })
        // Materialize transition effects
        for (const effect of transition.effects ?? []) {
          materializeTransitionEffect(nextTask, event, effect, derivedActor, idempotencyKey)
        }
        return { ok: true, task: clone(nextTask) }
      }
      if (action.type === 'escalate') {
        const anomaly: WorkflowAnomaly = {
          anomalyId: nextId('anom'),
          taskId: task.taskId,
          workflow: task.workflow,
          supervisorRunId: request.supervisorRunId,
          category: 'policy_conflict',
          stateAtObservation: clone(task.state),
          taskVersion: task.version,
          summary: action.reason,
          createdAt: now,
        }
        anomalies.set(task.taskId, [...(anomalies.get(task.taskId) ?? []), clone(anomaly)])
        const event = appendEvent(task, {
          taskId: task.taskId,
          type: 'supervisor.escalated',
          actor: supervisorRun.supervisor,
          supervisorRunId: request.supervisorRunId,
          observedTaskVersion: task.version,
          idempotencyKey,
          payload: {
            reason: action.reason,
            severity: action.severity,
            ...(action.audience ? { audience: action.audience } : {}),
            anomalyId: anomaly.anomalyId,
          },
        })
        // Produce a canonical effect intent for human_review obligation
        createEffectIntent(
          task,
          event.eventId,
          idempotencyKey,
          'create_obligation',
          {
            kind: 'human_review',
            reason: action.reason,
            blocking: action.severity === 'critical',
            severity: action.severity,
            ...(action.audience ? { audience: action.audience } : {}),
          },
          supervisorRun.supervisor,
          task.version
        )
        return { ok: true, task: clone(task), anomaly: clone(anomaly) }
      }
      return { ok: true, task: clone(task) }
    })

  const compileParticipantContext = (request: {
    taskId: string
    runId: string
    actor: ActorRef
    role: string
    sessionRef: { scopeRef: string; laneRef: string }
    idempotencyPrefix: string
  }): Record<string, unknown> => {
    const task = tasks.get(request.taskId)
    if (task === undefined) {
      throw new Error(`Task not found: ${request.taskId}`)
    }
    const definition = getDefinitionForTask(task)
    const allEvidence = evidence.get(task.taskId) ?? []
    const allowedTransitions: Record<string, unknown>[] = []
    const unavailableTransitions: Record<string, unknown>[] = []
    for (const transition of Object.values(definition.transitions)) {
      const error = evaluateTransition(task, transition, request.actor, request.role, allEvidence)
      if (error === undefined) {
        allowedTransitions.push(buildTransitionAffordance(task, transition, request.role))
      } else if ((transition.by ?? []).includes(request.role)) {
        unavailableTransitions.push({
          id: transition.id,
          reasonCode: error.code,
          reason: error.message,
          ...(error.missingEvidenceKinds
            ? { missingEvidenceKinds: error.missingEvidenceKinds }
            : {}),
          ...(error.blockingObligationIds
            ? { blockingObligationIds: error.blockingObligationIds }
            : {}),
        })
      }
    }
    const context: Record<string, unknown> = {
      schemaVersion: 1,
      task: {
        id: task.taskId,
        projectId: task.projectId,
        workflow: task.workflow,
        state: task.state,
        version: task.version,
        goal: task.goal,
        ...(task.risk ? { risk: task.risk } : {}),
      },
      run: {
        id: request.runId,
        actor: request.actor,
        role: request.role,
        sessionRef: request.sessionRef,
        idempotencyPrefix: request.idempotencyPrefix,
      },
      roleObjective: {
        current: `Act as ${request.role} for the current workflow state.`,
        doneWhen: allowedTransitions.map(
          (transition) => `Apply ${transition['id']} when requirements are met.`
        ),
      },
      assignedObligations: (obligations.get(task.taskId) ?? []).filter(
        (obligation) => obligation.ownerRole === request.role
      ),
      relevantEvidence: allEvidence,
      allowedTransitions,
      unavailableTransitions,
      commands: {
        refreshContext: makeCommand('acp.workflow.participantContext', {
          taskId: task.taskId,
          role: request.role,
          runId: request.runId,
        }),
        attachEvidence: makeCommand('acp.workflow.attachEvidence', {
          taskId: task.taskId,
          expectedTaskVersion: task.version,
          idempotencyKey: `${request.idempotencyPrefix}:evidence:v${task.version}`,
        }),
        applyTransition: makeCommand('acp.workflow.applyTransition', {
          taskId: task.taskId,
          transitionId: '<transitionId>',
          expectedTaskVersion: task.version,
          role: request.role,
          idempotencyKey: `${request.idempotencyPrefix}:transition:<transitionId>:v${task.version}`,
        }),
        reportBlocker: makeCommand('acp.workflow.reportBlocker', {
          taskId: task.taskId,
          role: request.role,
          idempotencyKey: `${request.idempotencyPrefix}:blocker:v${task.version}`,
        }),
      },
    }
    const hash = contextHashFor(context)
    context['contextHash'] = hash
    rememberContextHash(task.taskId, hash)
    return clone(context)
  }

  const compileSupervisorContext = (request: {
    taskId: string
    runId: string
    actor: ActorRef
    autonomy: SupervisorBinding['autonomy']
    capabilities: SupervisorCapabilities
    idempotencyPrefix: string
  }): Record<string, unknown> => {
    const task = tasks.get(request.taskId)
    if (task === undefined) {
      throw new Error(`Task not found: ${request.taskId}`)
    }
    const definition = getDefinitionForTask(task)
    const allEvidence = evidence.get(task.taskId) ?? []
    const legalTransitionsByRole: Record<string, unknown[]> = {}
    const unavailableTransitions: Record<string, unknown>[] = []
    for (const role of Object.keys(definition.roles).sort()) {
      const actor = task.roleBindings[role] ?? request.actor
      const legal: Record<string, unknown>[] = []
      for (const transition of Object.values(definition.transitions)) {
        const error = evaluateTransition(task, transition, actor, role, allEvidence)
        if (error === undefined) {
          legal.push(buildTransitionAffordance(task, transition, role))
        } else if ((transition.by ?? []).includes(role)) {
          unavailableTransitions.push({
            id: transition.id,
            role,
            reasonCode: error.code,
            reason: error.message,
            remediation: error.suggestedActions ?? [],
          })
        }
      }
      legalTransitionsByRole[role] = legal
    }
    const allowedControlActions: Record<string, unknown>[] = []
    if (request.capabilities.launchRuns) {
      allowedControlActions.push({
        type: 'launch_participant_run',
        command: makeCommand('acp.workflow.controlAction', {
          taskId: task.taskId,
          action: { type: 'launch_participant_run', role: '<role>', actor: '<actor>' },
          expectedTaskVersion: task.version,
          idempotencyKey: `${request.idempotencyPrefix}:control:launch:v${task.version}`,
        }),
      })
    }
    if (request.capabilities.createObligations) {
      allowedControlActions.push({
        type: 'create_obligation',
        command: makeCommand('acp.workflow.controlAction', {
          taskId: task.taskId,
          action: { type: 'create_obligation', kind: '<kind>', summary: '<summary>' },
          expectedTaskVersion: task.version,
          idempotencyKey: `${request.idempotencyPrefix}:control:obligation:v${task.version}`,
        }),
      })
    }
    if (request.capabilities.satisfyObligations) {
      for (const obligation of (obligations.get(task.taskId) ?? []).filter(
        (candidate) => candidate.status === 'open'
      )) {
        allowedControlActions.push({
          type: 'satisfy_obligation',
          obligationId: obligation.obligationId,
          command: makeCommand('acp.workflow.controlAction', {
            taskId: task.taskId,
            action: { type: 'satisfy_obligation', obligationId: obligation.obligationId },
            expectedTaskVersion: task.version,
            idempotencyKey: `${request.idempotencyPrefix}:control:satisfy:${obligation.obligationId}:v${task.version}`,
          }),
        })
      }
    }
    if (request.capabilities.proposeWorkflowPatches) {
      allowedControlActions.push({
        type: 'propose_workflow_patch',
        command: makeCommand('acp.workflow.controlAction', {
          taskId: task.taskId,
          action: { type: 'propose_workflow_patch', patchKind: '<patchKind>' },
          expectedTaskVersion: task.version,
          idempotencyKey: `${request.idempotencyPrefix}:control:patch:v${task.version}`,
        }),
      })
    }
    if (request.capabilities.attachEvidence) {
      allowedControlActions.push({
        type: 'attach_evidence',
        command: makeCommand('acp.workflow.controlAction', {
          taskId: task.taskId,
          action: {
            type: 'attach_evidence',
            evidence: [{ kind: '<kind>', ref: '<ref>' }],
          },
          expectedTaskVersion: task.version,
          idempotencyKey: `${request.idempotencyPrefix}:control:evidence:v${task.version}`,
        }),
      })
    }
    if (request.capabilities.applySupervisorTransitions) {
      allowedControlActions.push({
        type: 'apply_transition',
        command: makeCommand('acp.workflow.controlAction', {
          taskId: task.taskId,
          action: {
            type: 'apply_transition',
            transitionId: '<transitionId>',
            evidenceRefs: ['<evidenceRef>'],
          },
          expectedTaskVersion: task.version,
          idempotencyKey: `${request.idempotencyPrefix}:control:transition:v${task.version}`,
        }),
      })
    }
    if (request.capabilities.escalate) {
      allowedControlActions.push({
        type: 'escalate',
        command: makeCommand('acp.workflow.controlAction', {
          taskId: task.taskId,
          action: {
            type: 'escalate',
            reason: '<reason>',
            severity: '<severity>',
          },
          expectedTaskVersion: task.version,
          idempotencyKey: `${request.idempotencyPrefix}:control:escalate:v${task.version}`,
        }),
      })
    }
    if (request.capabilities.pauseSupervision) {
      allowedControlActions.push({
        type: 'pause_supervision',
        command: makeCommand('acp.workflow.controlAction', {
          taskId: task.taskId,
          action: { type: 'pause_supervision', reason: '<reason>' },
          idempotencyKey: `${request.idempotencyPrefix}:control:pause:v${task.version}`,
        }),
      })
      allowedControlActions.push({
        type: 'unpause_supervision',
        command: makeCommand('acp.workflow.controlAction', {
          taskId: task.taskId,
          action: { type: 'unpause_supervision' },
          idempotencyKey: `${request.idempotencyPrefix}:control:unpause:v${task.version}`,
        }),
      })
    }
    const context: Record<string, unknown> = {
      schemaVersion: 1,
      task: {
        id: task.taskId,
        projectId: task.projectId,
        workflow: task.workflow,
        state: task.state,
        version: task.version,
        goal: task.goal,
        ...(task.risk ? { risk: task.risk } : {}),
        ...(task.facts ? { facts: task.facts } : {}),
      },
      supervisor: {
        runId: request.runId,
        actor: request.actor,
        autonomy: request.autonomy,
        capabilities: request.capabilities,
        idempotencyPrefix: request.idempotencyPrefix,
      },
      roleBindings: task.roleBindings,
      activeParticipantRuns: participantRuns.get(task.taskId) ?? [],
      recentParticipantRuns: participantRuns.get(task.taskId) ?? [],
      evidence: allEvidence,
      obligations: obligations.get(task.taskId) ?? [],
      childTasks: [],
      handoffs: (effects.get(task.taskId) ?? []).filter(
        (effect) => effect.kind === 'declare_handoff'
      ),
      pendingEffects: (effects.get(task.taskId) ?? []).filter(
        (effect) => effect.state === 'pending'
      ),
      legalTransitionsByRole,
      supervisorTransitions: Object.values(definition.transitions)
        .filter((transition) => transition.supervisorBypass === true)
        .map((transition) => buildTransitionAffordance(task, transition, 'supervisor')),
      unavailableTransitions,
      allowedControlActions,
      anomalies: anomalies.get(task.taskId) ?? [],
      commands: {
        refreshContext: makeCommand('acp.workflow.supervisorContext', {
          taskId: task.taskId,
          runId: request.runId,
        }),
        launchParticipantRun: makeCommand('acp.workflow.controlAction', {
          taskId: task.taskId,
          action: 'launch_participant_run',
        }),
        sendInputToRun: makeCommand('acp.workflow.controlAction', {
          taskId: task.taskId,
          action: 'send_input_to_run',
        }),
        createObligation: makeCommand('acp.workflow.controlAction', {
          taskId: task.taskId,
          action: 'create_obligation',
        }),
        satisfyObligation: makeCommand('acp.workflow.controlAction', {
          taskId: task.taskId,
          action: 'satisfy_obligation',
        }),
        attachEvidence: makeCommand('acp.workflow.controlAction', {
          taskId: task.taskId,
          action: 'attach_evidence',
        }),
        applyTransition: makeCommand('acp.workflow.controlAction', {
          taskId: task.taskId,
          action: 'apply_transition',
        }),
        escalate: makeCommand('acp.workflow.controlAction', {
          taskId: task.taskId,
          action: 'escalate',
        }),
        createChildTask: makeCommand('acp.workflow.controlAction', {
          taskId: task.taskId,
          action: 'create_child_task',
        }),
        requestHumanInput: makeCommand('acp.workflow.controlAction', {
          taskId: task.taskId,
          action: 'request_human_input',
        }),
        proposeWorkflowPatch: makeCommand('acp.workflow.controlAction', {
          taskId: task.taskId,
          action: 'propose_workflow_patch',
        }),
        pauseSupervision: makeCommand('acp.workflow.controlAction', {
          taskId: task.taskId,
          action: 'pause_supervision',
        }),
        unpauseSupervision: makeCommand('acp.workflow.controlAction', {
          taskId: task.taskId,
          action: 'unpause_supervision',
        }),
      },
    }
    const hash = contextHashFor(context)
    context['contextHash'] = hash
    rememberContextHash(task.taskId, hash)
    return clone(context)
  }

  const validateAttachEvidenceProvenance = (
    task: WorkflowTask,
    request: {
      actor: ActorRef
      role?: string | undefined
      runId?: string | undefined
      supervisorRunId?: string | undefined
      participantRunId?: string | undefined
    }
  ): WorkflowRejection | undefined => {
    const taskParticipantRuns = participantRuns.get(task.taskId) ?? []
    if (request.participantRunId !== undefined) {
      const run = taskParticipantRuns.find((record) => record.runId === request.participantRunId)
      if (run === undefined) {
        return reject(
          'authority_not_granted',
          `Participant run ${request.participantRunId} not found on this task`
        ).error
      }
      if (!actorEquals(request.actor, run.actor)) {
        return reject(
          'authority_not_granted',
          `Request actor does not match participant run ${request.participantRunId}`
        ).error
      }
      if (request.role !== run.role) {
        return reject(
          'authority_not_granted',
          `Request role does not match participant run ${request.participantRunId}`
        ).error
      }
    }
    if (request.supervisorRunId !== undefined) {
      const run = [...supervisorRuns.values()]
        .flat()
        .find((record) => record.runId === request.supervisorRunId)
      if (run !== undefined) {
        if (run.taskId !== task.taskId) {
          return reject(
            'authority_not_granted',
            `Supervisor run ${request.supervisorRunId} does not belong to this task`
          ).error
        }
        if (!actorEquals(request.actor, run.supervisor)) {
          return reject(
            'authority_not_granted',
            `Request actor does not match supervisor run ${request.supervisorRunId}`
          ).error
        }
      }
    }
    if (request.runId === undefined) {
      return undefined
    }
    const knownParticipantRun = [...participantRuns.values()]
      .flat()
      .find((record) => record.runId === request.runId)
    const knownSupervisorRun = [...supervisorRuns.values()]
      .flat()
      .find((record) => record.runId === request.runId)
    if (knownParticipantRun !== undefined) {
      if (knownParticipantRun.taskId !== task.taskId) {
        return reject(
          'authority_not_granted',
          `Participant run ${request.runId} does not belong to this task`
        ).error
      }
      if (!actorEquals(request.actor, knownParticipantRun.actor)) {
        return reject(
          'authority_not_granted',
          `Request actor does not match participant run ${request.runId}`
        ).error
      }
      if (request.role !== knownParticipantRun.role) {
        return reject(
          'authority_not_granted',
          `Request role does not match participant run ${request.runId}`
        ).error
      }
    }
    if (knownSupervisorRun !== undefined) {
      if (knownSupervisorRun.taskId !== task.taskId) {
        return reject(
          'authority_not_granted',
          `Supervisor run ${request.runId} does not belong to this task`
        ).error
      }
      if (!actorEquals(request.actor, knownSupervisorRun.supervisor)) {
        return reject(
          'authority_not_granted',
          `Request actor does not match supervisor run ${request.runId}`
        ).error
      }
    }
    return undefined
  }

  const attachEvidence = (request: {
    taskId: string
    actor: ActorRef
    role?: string | undefined
    runId?: string | undefined
    supervisorRunId?: string | undefined
    participantRunId?: string | undefined
    evidence: EvidenceInput[]
    expectedTaskVersion?: number | undefined
    idempotencyKey?: string | undefined
  }): WorkflowResult<{ evidence: EvidenceRecord[] }> =>
    withIdempotency(request.idempotencyKey, request, () => {
      const idempotencyKey = request.idempotencyKey ?? ''
      const task = tasks.get(request.taskId)
      if (task === undefined) {
        return reject('task_not_found', `Task not found: ${request.taskId}`)
      }
      if (
        request.expectedTaskVersion !== undefined &&
        request.expectedTaskVersion !== task.version
      ) {
        return reject(
          'version_conflict',
          `Task version ${task.version} does not match expected version ${request.expectedTaskVersion}`
        )
      }
      const definition = getDefinitionForTask(task)
      const isSupervisor =
        task.supervisor !== undefined && actorEquals(task.supervisor.actor, request.actor)
      const isBoundRole =
        request.role !== undefined && actorEquals(task.roleBindings[request.role], request.actor)
      if (!isSupervisor && !isBoundRole) {
        return {
          ok: false,
          error: {
            code: 'authority_not_granted' as WorkflowRejectionCode,
            message: 'Actor is not authorized to attach evidence to this task',
          },
        }
      }
      const provenanceError = validateAttachEvidenceProvenance(task, request)
      if (provenanceError !== undefined) {
        return { ok: false, error: provenanceError }
      }
      if (request.supervisorRunId !== undefined && isSupervisor) {
        const supervisorRun = (supervisorRuns.get(task.taskId) ?? []).find(
          (run) => run.runId === request.supervisorRunId
        )
        if (supervisorRun === undefined) {
          return reject(
            'authority_not_granted',
            `Supervisor run "${request.supervisorRunId}" not found on task "${task.taskId}"`
          )
        }
        if (supervisorRun.capabilities.attachEvidence !== true) {
          return reject(
            'capability_not_granted',
            'Capability not granted for action "attach_evidence"'
          )
        }
      }
      for (const item of request.evidence) {
        if (definition.evidenceKinds[item.kind] === undefined) {
          return {
            ok: false,
            error: {
              code: 'invalid_evidence' as WorkflowRejectionCode,
              message: `Evidence kind "${item.kind}" is not defined by workflow "${definition.id}"`,
            },
          }
        }
      }
      const records = addEvidence(
        task,
        request.evidence,
        request.actor,
        idempotencyKey,
        task.version,
        {
          role: request.role,
          runId: request.runId,
          participantRunId: request.participantRunId,
          supervisorRunId: request.supervisorRunId,
        }
      )
      return { ok: true, evidence: clone(records) }
    })

  const waiveObligation = (
    obligationId: string,
    request: {
      actor: ActorRef
      supervisorRunId?: string | undefined
      reason: string
      evidenceRefs?: string[] | undefined
      idempotencyKey?: string | undefined
    }
  ): WorkflowResult<{ task: WorkflowTask; obligation: ObligationRecord }> =>
    withIdempotency(request.idempotencyKey, { obligationId, ...request }, () => {
      const idempotencyKey = request.idempotencyKey ?? ''
      const resolved = resolveObligation(obligationId)
      if (!resolved.ok) {
        return resolved
      }
      const { task, list, index, obligation } = resolved
      if (!hasObligationLifecycleAuthority(task, obligation, request.actor)) {
        return reject('authority_not_granted', 'Actor is not authorized to waive this obligation')
      }
      if (request.supervisorRunId !== undefined) {
        const supervisorRun = (supervisorRuns.get(task.taskId) ?? []).find(
          (run) => run.runId === request.supervisorRunId
        )
        if (supervisorRun === undefined) {
          return reject(
            'authority_not_granted',
            `Supervisor run "${request.supervisorRunId}" not found on task "${task.taskId}"`
          )
        }
        if (!actorEquals(request.actor, supervisorRun.supervisor)) {
          return reject(
            'authority_not_granted',
            `Request actor does not match supervisor run ${request.supervisorRunId}`
          )
        }
        if (supervisorRun.capabilities.createWaivers !== true) {
          return reject(
            'capability_not_granted',
            'Capability not granted for action "waive_obligation"'
          )
        }
      }
      const taskEvidence = evidence.get(task.taskId) ?? []
      for (const ref of request.evidenceRefs ?? []) {
        const record = taskEvidence.find((item) => item.evidenceId === ref)
        if (record === undefined || record.taskId !== task.taskId) {
          return reject('evidence_not_found', `Evidence not found: ${ref}`)
        }
      }
      const updatedObligation: ObligationRecord = {
        ...obligation,
        status: 'waived',
        updatedAt: now,
        waivedAt: now,
        waiverReason: request.reason,
        ...(request.evidenceRefs !== undefined
          ? { waiverEvidenceRefs: clone(request.evidenceRefs) }
          : {}),
      }
      const nextObligations = [...list]
      nextObligations[index] = updatedObligation
      obligations.set(task.taskId, clone(nextObligations))
      const nextTask = nextTaskAfterObligationClosed(task, nextObligations)
      tasks.set(task.taskId, clone(nextTask))
      clearContextHashes(task.taskId)
      appendEvent(nextTask, {
        taskId: task.taskId,
        type: 'waiver.recorded',
        actor: request.actor,
        ...(request.supervisorRunId !== undefined
          ? { supervisorRunId: request.supervisorRunId }
          : {}),
        observedTaskVersion: task.version,
        nextTaskVersion: nextTask.version,
        idempotencyKey,
        payload: {
          obligationId,
          waiverKind: obligation.kind,
          reason: request.reason,
          evidenceRefs: request.evidenceRefs ?? [],
        },
      })
      appendEvent(nextTask, {
        taskId: task.taskId,
        type: 'obligation.waived',
        actor: request.actor,
        ...(request.supervisorRunId !== undefined
          ? { supervisorRunId: request.supervisorRunId }
          : {}),
        observedTaskVersion: task.version,
        nextTaskVersion: nextTask.version,
        idempotencyKey,
        payload: {
          obligationId,
          kind: obligation.kind,
          reason: request.reason,
          evidenceRefs: request.evidenceRefs ?? [],
        },
      })
      return { ok: true, task: clone(nextTask), obligation: clone(updatedObligation) }
    })

  const cancelObligation = (
    obligationId: string,
    request: {
      actor: ActorRef
      reason: string
      idempotencyKey?: string | undefined
    }
  ): WorkflowResult<{ task: WorkflowTask; obligation: ObligationRecord }> =>
    withIdempotency(request.idempotencyKey, { obligationId, ...request }, () => {
      const idempotencyKey = request.idempotencyKey ?? ''
      const resolved = resolveObligation(obligationId)
      if (!resolved.ok) {
        return resolved
      }
      const { task, list, index, obligation } = resolved
      if (!hasObligationLifecycleAuthority(task, obligation, request.actor)) {
        return reject('authority_not_granted', 'Actor is not authorized to cancel this obligation')
      }
      const updatedObligation: ObligationRecord = {
        ...obligation,
        status: 'cancelled',
        updatedAt: now,
        cancelledAt: now,
        cancelReason: request.reason,
      }
      const nextObligations = [...list]
      nextObligations[index] = updatedObligation
      obligations.set(task.taskId, clone(nextObligations))
      const nextTask = nextTaskAfterObligationClosed(task, nextObligations)
      tasks.set(task.taskId, clone(nextTask))
      clearContextHashes(task.taskId)
      appendEvent(nextTask, {
        taskId: task.taskId,
        type: 'obligation.cancelled',
        actor: request.actor,
        observedTaskVersion: task.version,
        nextTaskVersion: nextTask.version,
        idempotencyKey,
        payload: {
          obligationId,
          kind: obligation.kind,
          reason: request.reason,
        },
      })
      return { ok: true, task: clone(nextTask), obligation: clone(updatedObligation) }
    })

  const expireObligation = (
    obligationId: string,
    request: {
      reason: string
      actor?: ActorRef | undefined
      idempotencyKey?: string | undefined
    }
  ): WorkflowResult<{ task: WorkflowTask; obligation: ObligationRecord }> =>
    withIdempotency(
      request.idempotencyKey ?? `obligation:expire:${obligationId}:${request.reason}`,
      { obligationId, ...request },
      () => {
        const idempotencyKey =
          request.idempotencyKey ?? `obligation:expire:${obligationId}:${request.reason}`
        const resolved = resolveObligation(obligationId)
        if (!resolved.ok) {
          return resolved
        }
        const { task, list, index, obligation } = resolved
        const actor = request.actor ?? { kind: 'service', id: 'workflow-timer' }
        const updatedObligation: ObligationRecord = {
          ...obligation,
          status: 'expired',
          updatedAt: now,
          expiredAt: now,
          expireReason: request.reason,
        }
        const nextObligations = [...list]
        nextObligations[index] = updatedObligation
        obligations.set(task.taskId, clone(nextObligations))
        const nextTask = nextTaskAfterObligationClosed(task, nextObligations)
        tasks.set(task.taskId, clone(nextTask))
        clearContextHashes(task.taskId)
        appendEvent(nextTask, {
          taskId: task.taskId,
          type: 'obligation.expired',
          actor,
          observedTaskVersion: task.version,
          nextTaskVersion: nextTask.version,
          idempotencyKey,
          payload: {
            obligationId,
            kind: obligation.kind,
            reason: request.reason,
          },
        })
        return { ok: true, task: clone(nextTask), obligation: clone(updatedObligation) }
      }
    )

  const buildParticipantRunContext = (
    task: WorkflowTask,
    run: ParticipantRunRecord
  ): Record<string, unknown> => {
    const definition = getDefinitionForTask(task)
    const allEvidence = evidence.get(task.taskId) ?? []
    const allowedTransitions: Record<string, unknown>[] = []
    for (const transition of Object.values(definition.transitions)) {
      const error = evaluateTransition(task, transition, run.actor, run.role, allEvidence)
      if (error === undefined) {
        allowedTransitions.push(buildTransitionAffordance(task, transition, run.role))
      }
    }
    const context: Record<string, unknown> = {
      schemaVersion: 1,
      task: {
        id: task.taskId,
        projectId: task.projectId,
        workflow: task.workflow,
        state: task.state,
        version: task.version,
        goal: task.goal,
        ...(task.risk ? { risk: task.risk } : {}),
      },
      run: {
        id: run.runId,
        actor: run.actor,
        role: run.role,
      },
      roleObjective: {
        current: `Act as ${run.role} for the current workflow state.`,
        doneWhen: allowedTransitions.map(
          (transition) => `Apply ${transition['id']} when requirements are met.`
        ),
      },
      assignedObligations: (obligations.get(task.taskId) ?? []).filter(
        (obligation) => obligation.ownerRole === run.role
      ),
      relevantEvidence: allEvidence,
      allowedTransitions,
    }
    const hash = contextHashFor(context)
    context['contextHash'] = hash
    rememberContextHash(task.taskId, hash)
    return clone(context)
  }

  const startParticipantRun = (request: {
    taskId: string
    role: string
    actor: ActorRef
    harness?: Record<string, unknown> | undefined
    parentSupervisorRunId?: string | undefined
    idempotencyKey?: string | undefined
  }): WorkflowResult<{ participantRun: ParticipantRunRecord; context: Record<string, unknown> }> =>
    withIdempotency(request.idempotencyKey, request, () => {
      const idempotencyKey = request.idempotencyKey ?? ''
      const task = tasks.get(request.taskId)
      if (task === undefined) {
        return reject('task_not_found', `Task not found: ${request.taskId}`)
      }
      const definition = getDefinitionForTask(task)
      if (definition.roles[request.role] === undefined) {
        return reject(
          'role_not_bound',
          `Role "${request.role}" is not defined by workflow "${definition.id}"`
        )
      }
      const boundActor = task.roleBindings[request.role]
      if (boundActor === undefined || boundActor === null) {
        return reject(
          'role_not_bound',
          `Role "${request.role}" is not bound — cannot launch participant run`
        )
      }
      if (!actorEquals(boundActor, request.actor)) {
        return reject('role_not_bound', `Role "${request.role}" is bound to a different actor`)
      }
      const runId = nextId('prun')
      const run: ParticipantRunRecord = {
        runId,
        kind: 'participant',
        taskId: task.taskId,
        workflow: task.workflow,
        actor: clone(request.actor),
        role: request.role,
        status: 'launched',
        ...(request.parentSupervisorRunId !== undefined
          ? { parentSupervisorRunId: request.parentSupervisorRunId }
          : {}),
        taskVersionAtStart: task.version,
        contextHash: '', // placeholder, set below
        createdAt: now,
      }
      const context = buildParticipantRunContext(task, run)
      run.contextHash = String(context['contextHash'])
      participantRuns.set(task.taskId, [...(participantRuns.get(task.taskId) ?? []), clone(run)])
      appendEvent(task, {
        taskId: task.taskId,
        type: 'participant_run.launched',
        actor: request.actor,
        participantRunId: runId,
        observedTaskVersion: task.version,
        idempotencyKey,
        payload: { runId, role: run.role, actor: clone(request.actor) },
      })
      return { ok: true, participantRun: clone(run), context: clone(context) }
    })

  const resumeParticipantRun = (request: {
    taskId: string
    role: string
    actor: ActorRef
  }): WorkflowResult<{
    participantRun: ParticipantRunRecord
    context: Record<string, unknown>
  }> => {
    const task = tasks.get(request.taskId)
    if (task === undefined) {
      return reject('task_not_found', `Task not found: ${request.taskId}`)
    }
    const runs = participantRuns.get(task.taskId) ?? []
    const existing = runs.find(
      (run) =>
        run.role === request.role &&
        actorEquals(run.actor, request.actor) &&
        (run.status === 'launched' || run.status === 'running')
    )
    if (existing === undefined) {
      return reject('task_not_found', 'No active participant run found for this role and actor')
    }
    const context = buildParticipantRunContext(task, existing)
    const updatedRun = { ...existing, contextHash: String(context['contextHash']) }
    // Update the stored run's contextHash
    const allRuns = participantRuns.get(task.taskId) ?? []
    const idx = allRuns.findIndex((r) => r.runId === existing.runId)
    if (idx >= 0) {
      allRuns[idx] = clone(updatedRun)
      participantRuns.set(task.taskId, [...allRuns])
    }
    return { ok: true, participantRun: clone(updatedRun), context: clone(context) }
  }

  const markParticipantRunRunning = (
    runId: string,
    request: { idempotencyKey?: string | undefined } = {}
  ): WorkflowResult<{ participantRun: ParticipantRunRecord }> =>
    withIdempotency(request.idempotencyKey, { runId, ...request }, () => {
      for (const [taskId, runs] of participantRuns.entries()) {
        const idx = runs.findIndex((run) => run.runId === runId)
        if (idx < 0) continue
        const run = runs[idx]
        if (run === undefined) continue
        if (run.status !== 'launched') {
          return reject(
            'state_mismatch',
            `Cannot mark run ${runId} as running from status "${run.status}"`
          )
        }
        const updated: ParticipantRunRecord = { ...run, status: 'running' }
        const nextRuns = [...runs]
        nextRuns[idx] = clone(updated)
        participantRuns.set(taskId, nextRuns)
        return { ok: true, participantRun: clone(updated) }
      }
      return reject('task_not_found', `Participant run not found: ${runId}`)
    })

  const completeParticipantRun = (
    runId: string,
    request: {
      outcome: string
      evidenceRefs?: string[] | undefined
      summary?: string | undefined
      idempotencyKey?: string | undefined
    }
  ): WorkflowResult<{ participantRun: ParticipantRunRecord }> =>
    withIdempotency(request.idempotencyKey, { runId, ...request }, () => {
      for (const [taskId, runs] of participantRuns.entries()) {
        const idx = runs.findIndex((run) => run.runId === runId)
        if (idx < 0) continue
        const run = runs[idx]
        if (run === undefined) continue
        const task = tasks.get(taskId)
        if (task === undefined) continue
        const updated: ParticipantRunRecord = {
          ...run,
          status: 'completed',
          completedAt: now,
          outcome: request.outcome,
          ...(request.summary !== undefined ? { summary: request.summary } : {}),
        }
        const nextRuns = [...runs]
        nextRuns[idx] = clone(updated)
        participantRuns.set(taskId, nextRuns)
        appendEvent(task, {
          taskId,
          type: 'participant_run.completed',
          actor: run.actor,
          participantRunId: runId,
          observedTaskVersion: task.version,
          idempotencyKey: request.idempotencyKey ?? '',
          payload: {
            outcome: request.outcome,
            ...(request.evidenceRefs !== undefined ? { evidenceRefs: request.evidenceRefs } : {}),
            ...(request.summary !== undefined ? { summary: request.summary } : {}),
          },
        })
        return { ok: true, participantRun: clone(updated) }
      }
      return reject('task_not_found', `Participant run not found: ${runId}`)
    })

  const failParticipantRun = (
    runId: string,
    request: {
      reason: string
      classification?: string | undefined
      idempotencyKey?: string | undefined
    }
  ): WorkflowResult<{ participantRun: ParticipantRunRecord }> =>
    withIdempotency(request.idempotencyKey, { runId, ...request }, () => {
      for (const [taskId, runs] of participantRuns.entries()) {
        const idx = runs.findIndex((run) => run.runId === runId)
        if (idx < 0) continue
        const run = runs[idx]
        if (run === undefined) continue
        const task = tasks.get(taskId)
        if (task === undefined) continue
        const updated: ParticipantRunRecord = {
          ...run,
          status: 'failed',
          completedAt: now,
          outcome: 'failed',
          failureReason: request.reason,
          ...(request.classification !== undefined
            ? { failureClassification: request.classification }
            : {}),
        }
        const nextRuns = [...runs]
        nextRuns[idx] = clone(updated)
        participantRuns.set(taskId, nextRuns)
        appendEvent(task, {
          taskId,
          type: 'participant_run.completed',
          actor: run.actor,
          participantRunId: runId,
          observedTaskVersion: task.version,
          idempotencyKey: request.idempotencyKey ?? '',
          payload: {
            outcome: 'failed',
            reason: request.reason,
            ...(request.classification !== undefined
              ? { classification: request.classification }
              : {}),
          },
        })
        return { ok: true, participantRun: clone(updated) }
      }
      return reject('task_not_found', `Participant run not found: ${runId}`)
    })

  const cancelParticipantRun = (
    runId: string,
    request: {
      reason: string
      idempotencyKey?: string | undefined
    }
  ): WorkflowResult<{ participantRun: ParticipantRunRecord }> =>
    withIdempotency(request.idempotencyKey, { runId, ...request }, () => {
      for (const [taskId, runs] of participantRuns.entries()) {
        const idx = runs.findIndex((run) => run.runId === runId)
        if (idx < 0) continue
        const run = runs[idx]
        if (run === undefined) continue
        const task = tasks.get(taskId)
        if (task === undefined) continue
        const updated: ParticipantRunRecord = {
          ...run,
          status: 'cancelled',
          completedAt: now,
          cancelReason: request.reason,
        }
        const nextRuns = [...runs]
        nextRuns[idx] = clone(updated)
        participantRuns.set(taskId, nextRuns)
        appendEvent(task, {
          taskId,
          type: 'participant_run.cancelled',
          actor: run.actor,
          participantRunId: runId,
          observedTaskVersion: task.version,
          idempotencyKey: request.idempotencyKey ?? '',
          payload: {
            reason: request.reason,
          },
        })
        return { ok: true, participantRun: clone(updated) }
      }
      return reject('task_not_found', `Participant run not found: ${runId}`)
    })

  return {
    publishWorkflowDefinition,
    getWorkflowDefinition,
    createTask,
    startSupervisorRun,
    applyTransition,
    attachEvidence,
    waiveObligation,
    cancelObligation,
    expireObligation,
    submitControlAction,
    compileParticipantContext,
    compileSupervisorContext,
    startParticipantRun,
    resumeParticipantRun,
    markParticipantRunRunning,
    completeParticipantRun,
    failParticipantRun,
    cancelParticipantRun,
    getTask: (taskId: string): WorkflowTask | undefined => clone(tasks.get(taskId)),
    listEvents: (taskId: string): WorkflowEvent[] => clone(events.get(taskId) ?? []),
    listSupervisorRuns: (taskId: string): SupervisorRunRecord[] =>
      clone(supervisorRuns.get(taskId) ?? []),
    listEvidence: (taskId: string): EvidenceRecord[] => clone(evidence.get(taskId) ?? []),
    listObligations: (taskId: string): ObligationRecord[] => clone(obligations.get(taskId) ?? []),
    listEffectIntents: (taskId: string): EffectIntent[] => clone(effects.get(taskId) ?? []),
    listParticipantRuns: (taskId: string): ParticipantRunRecord[] =>
      clone(participantRuns.get(taskId) ?? []),
    listAnomalies: (taskId: string): WorkflowAnomaly[] => clone(anomalies.get(taskId) ?? []),
    listWorkflowPatchProposals: (taskId: string): WorkflowPatchProposal[] =>
      clone(patchProposals.get(taskId) ?? []),
    exportSnapshot: (): WorkflowKernelSnapshot => ({
      definitions: clone([...definitions.values()]),
      tasks: clone([...tasks.values()]),
      evidence: clone([...evidence.values()].flat()),
      obligations: clone([...obligations.values()].flat()),
      effects: clone([...effects.values()].flat()),
      events: clone([...events.values()].flat()),
      supervisorRuns: clone([...supervisorRuns.values()].flat()),
      participantRuns: clone([...participantRuns.values()].flat()),
      anomalies: clone([...anomalies.values()].flat()),
      patchProposals: clone([...patchProposals.values()].flat()),
      idempotency: clone(
        [...idempotency.entries()].map(([key, record]) => ({
          key,
          record,
        }))
      ),
      contextHashes: [...currentContextHashes.entries()].map(([taskId, hashes]) => ({
        taskId,
        hashes: [...hashes],
      })),
      sequence,
    }),
  }
}
