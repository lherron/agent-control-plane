import { createHash } from 'node:crypto'

import type {
  ActorRef,
  EffectIntent,
  EvidenceRecord,
  ObligationRecord,
  ParticipantRunRecord,
  PublishedWorkflowDefinition,
  SupervisorCapabilities,
  SupervisorRunRecord,
  WorkState,
  WorkflowAnomaly,
  WorkflowEvent,
  WorkflowHrcRunMap,
  WorkflowIdempotencyRecord,
  WorkflowKernelSnapshot,
  WorkflowPatchProposal,
  WorkflowRef,
  WorkflowTask,
} from 'acp-core'

import type { RepoContext } from './shared.js'

type DefinitionRow = {
  definition_json: string
}

type TaskRow = {
  task_id: string
  project_id: string
  workflow_id: string
  workflow_version: number
  workflow_hash: string
  state_json: string
  version: number
  goal: string
  risk: string | null
  facts_json: string | null
  role_bindings_json: string
  supervisor_json: string | null
  created_at: string
  updated_at: string
}

type EvidenceRow = {
  evidence_id: string
  task_id: string
  kind: string
  ref: string
  summary: string | null
  data_json: string | null
  actor_json: string | null
  role: string | null
  run_id: string | null
  participant_run_id: string | null
  supervisor_run_id: string | null
  created_at: string
}

type ObligationRow = {
  obligation_id: string
  task_id: string
  kind: string
  owner_role: string | null
  summary: string
  blocking: number
  status: ObligationRecord['status']
  created_at: string
  updated_at: string
  satisfied_at: string | null
  satisfaction_evidence_ids_json: string | null
  waived_at: string | null
  waiver_reason: string | null
  waiver_evidence_refs_json: string | null
  cancelled_at: string | null
  cancel_reason: string | null
  expired_at: string | null
  expire_reason: string | null
}

type EventRow = {
  event_id: string
  workflow_seq: number
  schema_version: number
  task_id: string
  workflow_id: string
  workflow_version: number
  workflow_hash: string
  type: string
  command_type: string | null
  command_hash: string | null
  causation_id: string | null
  correlation_id: string | null
  actor_json: string
  role: string | null
  authority: string | null
  run_id: string | null
  supervisor_run_id: string | null
  participant_run_id: string | null
  observed_task_version: number
  next_task_version: number | null
  context_hash: string | null
  idempotency_key: string
  result: WorkflowEvent['result']
  rejection_code: string | null
  payload_json: string
  event_hash: string
  prev_hash: string | null
  created_at: string
}

type WorkflowHrcRunMapRow = {
  map_id: string
  workflow_task_id: string
  participant_run_id: string | null
  supervisor_run_id: string | null
  hrc_run_id: string
  runtime_id: string | null
  launch_id: string | null
  host_session_id: string | null
  scope_ref: string | null
  lane_ref: string | null
  generation: number | null
  created_at: string
  source: WorkflowHrcRunMap['source']
}

type EffectRow = {
  effect_id: string
  task_id: string
  source_event_id: string
  kind: string
  payload_json: string
  idempotency_key: string
  state: EffectIntent['state']
  created_at: string
  updated_at: string
}

type ParticipantRunRow = {
  run_id: string
  task_id: string
  workflow_json: string
  actor_json: string
  role: string
  status: string
  parent_supervisor_run_id: string | null
  task_version_at_start: number
  context_hash: string
  created_at: string
}

type SupervisorRunRow = {
  run_id: string
  task_id: string
  workflow_json: string
  supervisor_json: string
  autonomy: SupervisorRunRecord['autonomy']
  capabilities_json: string
  harness_json: string | null
  task_version_at_start: number
  context_hash: string
  created_at: string
  paused: number
  paused_reason: string | null
}

type AnomalyRow = {
  anomaly_id: string
  task_id: string
  workflow_json: string
  supervisor_run_id: string | null
  category: WorkflowAnomaly['category']
  state_at_observation_json: string
  task_version: number
  summary: string
  proposed_recovery: string | null
  created_at: string
}

type PatchProposalRow = {
  proposal_id: string
  task_id: string
  base_workflow_json: string
  proposed_version: number | null
  source_anomaly_ids_json: string
  patch_kind: WorkflowPatchProposal['patchKind']
  patch_json: string
  rationale_summary: string
  status: WorkflowPatchProposal['status']
  created_by_json: string
  created_at: string
}

type IdempotencyRow = {
  idempotency_key: string
  fingerprint: string
  result_json: string
}

type ContextHashRow = {
  task_id: string
  context_hash: string
}

type MetaRow = {
  value_json: string
}

function stringify(value: unknown): string {
  return JSON.stringify(value)
}

function parse<T>(value: string): T {
  return JSON.parse(value) as T
}

function optional<T>(value: T | null): T | undefined {
  return value === null ? undefined : value
}

function stableJson(value: unknown): string {
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

function mapTask(row: TaskRow): WorkflowTask {
  const risk = optional(row.risk)
  const facts = row.facts_json === null ? undefined : parse<Record<string, unknown>>(row.facts_json)
  const supervisor =
    row.supervisor_json === null
      ? undefined
      : parse<WorkflowTask['supervisor']>(row.supervisor_json)
  return {
    taskId: row.task_id,
    projectId: row.project_id,
    workflow: {
      id: row.workflow_id,
      version: row.workflow_version,
      hash: row.workflow_hash,
    },
    state: parse<WorkState>(row.state_json),
    version: row.version,
    goal: row.goal,
    ...(risk !== undefined ? { risk } : {}),
    ...(facts !== undefined ? { facts } : {}),
    roleBindings: parse<WorkflowTask['roleBindings']>(row.role_bindings_json),
    ...(supervisor !== undefined ? { supervisor } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class WorkflowRuntimeRepo {
  constructor(private readonly context: RepoContext) {}

  private appendEffectLifecycleEvent(
    effect: EffectRow,
    input: {
      type: string
      deliveryResult?: string | undefined
      errorCode?: string | undefined
      errorMessage?: string | undefined
    }
  ): void {
    const source = this.context.sqlite
      .prepare(
        `SELECT event_id, workflow_seq, schema_version, task_id, workflow_id,
                workflow_version, workflow_hash, actor_json, observed_task_version,
                next_task_version, event_hash
           FROM workflow_events
          WHERE event_id = ?`
      )
      .get(effect.source_event_id) as
      | Pick<
          EventRow,
          | 'event_id'
          | 'workflow_seq'
          | 'schema_version'
          | 'task_id'
          | 'workflow_id'
          | 'workflow_version'
          | 'workflow_hash'
          | 'actor_json'
          | 'observed_task_version'
          | 'next_task_version'
          | 'event_hash'
        >
      | undefined

    if (source === undefined) {
      throw new Error(`workflow effect source event missing: ${effect.source_event_id}`)
    }

    const workflowSeq =
      (
        this.context.sqlite
          .prepare(
            'SELECT max(workflow_seq) AS workflow_seq FROM workflow_events WHERE task_id = ?'
          )
          .get(effect.task_id) as { workflow_seq: number | null } | undefined
      )?.workflow_seq ?? 0
    const eventId = `wevt_${effect.effect_id}_${input.type.replaceAll('.', '_')}`
    const payload = {
      effectId: effect.effect_id,
      effectKind: effect.kind,
      ...(input.deliveryResult !== undefined ? { deliveryResult: input.deliveryResult } : {}),
      ...(input.errorCode !== undefined ? { errorCode: input.errorCode } : {}),
      ...(input.errorMessage !== undefined ? { errorMessage: input.errorMessage } : {}),
      sourceWorkflowEventId: effect.source_event_id,
    }
    const eventWithoutHash = {
      eventId,
      workflowSeq: workflowSeq + 1,
      schemaVersion: 1,
      taskId: effect.task_id,
      workflow: {
        id: source.workflow_id,
        version: source.workflow_version,
        hash: source.workflow_hash,
      },
      type: input.type,
      commandType: input.type,
      commandHash: hashValue({ type: input.type, effectId: effect.effect_id, payload }),
      causationId: source.event_id,
      actor: parse<ActorRef>(source.actor_json),
      observedTaskVersion: source.next_task_version ?? source.observed_task_version,
      idempotencyKey: `${effect.idempotency_key}:${input.type}`,
      result: 'recorded' as const,
      payload,
      prevHash: source.event_hash,
      createdAt: new Date().toISOString(),
    }
    this.context.sqlite
      .prepare(
        `INSERT OR IGNORE INTO workflow_events (
           event_id, workflow_seq, schema_version, task_id, workflow_id, workflow_version,
           workflow_hash, type, command_type, command_hash, causation_id, correlation_id,
           actor_json, role, authority, run_id, supervisor_run_id, participant_run_id,
           observed_task_version, next_task_version, context_hash, idempotency_key, result,
           rejection_code, payload_json, event_hash, prev_hash, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        eventWithoutHash.eventId,
        eventWithoutHash.workflowSeq,
        eventWithoutHash.schemaVersion,
        eventWithoutHash.taskId,
        eventWithoutHash.workflow.id,
        eventWithoutHash.workflow.version,
        eventWithoutHash.workflow.hash,
        eventWithoutHash.type,
        eventWithoutHash.commandType,
        eventWithoutHash.commandHash,
        eventWithoutHash.causationId,
        null,
        stringify(eventWithoutHash.actor),
        null,
        null,
        null,
        null,
        null,
        eventWithoutHash.observedTaskVersion,
        null,
        null,
        eventWithoutHash.idempotencyKey,
        eventWithoutHash.result,
        null,
        stringify(eventWithoutHash.payload),
        hashValue(eventWithoutHash),
        eventWithoutHash.prevHash,
        eventWithoutHash.createdAt
      )
  }

  listPendingEffectIntents(limit = 100): EffectIntent[] {
    const rows = this.context.sqlite
      .prepare(
        `SELECT effect_id, task_id, source_event_id, kind, payload_json, idempotency_key,
                state, created_at, updated_at
           FROM workflow_effect_intents
          WHERE state = 'pending'
       ORDER BY created_at, effect_id
          LIMIT ?`
      )
      .all(limit) as EffectRow[]

    return rows.map(
      (row): EffectIntent => ({
        effectId: row.effect_id,
        taskId: row.task_id,
        sourceEventId: row.source_event_id,
        kind: row.kind,
        payload: parse<Record<string, unknown>>(row.payload_json),
        idempotencyKey: row.idempotency_key,
        state: row.state,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })
    )
  }

  leaseEffectIntent(effectId: string): EffectIntent | undefined {
    return this.context.sqlite.transaction((id: string) => {
      const existing = this.context.sqlite
        .prepare(
          `SELECT effect_id, task_id, source_event_id, kind, payload_json, idempotency_key,
                  state, created_at, updated_at
             FROM workflow_effect_intents
            WHERE effect_id = ?`
        )
        .get(id) as EffectRow | null

      if (existing === null || existing.state !== 'pending') {
        return undefined
      }

      const updatedAt = new Date().toISOString()
      this.context.sqlite
        .prepare('UPDATE workflow_effect_intents SET state = ?, updated_at = ? WHERE effect_id = ?')
        .run('leased', updatedAt, id)

      this.appendEffectLifecycleEvent(existing, { type: 'effect.intent.leased' })

      return {
        effectId: existing.effect_id,
        taskId: existing.task_id,
        sourceEventId: existing.source_event_id,
        kind: existing.kind,
        payload: parse<Record<string, unknown>>(existing.payload_json),
        idempotencyKey: existing.idempotency_key,
        state: 'leased',
        createdAt: existing.created_at,
        updatedAt,
      } satisfies EffectIntent
    })(effectId)
  }

  /**
   * Transition an effect intent to a terminal state and append the matching
   * lifecycle event. No-op (matching the prior per-method guard) when the
   * effect is absent or already in the target state.
   */
  private transitionEffectIntent(
    effectId: string,
    target: EffectRow['state'],
    lifecycleEvent: (effect: EffectRow) => {
      type: string
      deliveryResult?: string | undefined
      errorCode?: string | undefined
      errorMessage?: string | undefined
    }
  ): void {
    const existing = this.context.sqlite
      .prepare(
        `SELECT effect_id, task_id, source_event_id, kind, payload_json, idempotency_key,
                state, created_at, updated_at
           FROM workflow_effect_intents
          WHERE effect_id = ?`
      )
      .get(effectId) as EffectRow | undefined
    if (existing === undefined || existing.state === target) {
      return
    }
    this.context.sqlite
      .prepare('UPDATE workflow_effect_intents SET state = ?, updated_at = ? WHERE effect_id = ?')
      .run(target, new Date().toISOString(), effectId)
    this.appendEffectLifecycleEvent(existing, lifecycleEvent(existing))
  }

  markEffectIntentDelivered(effectId: string): void {
    this.transitionEffectIntent(effectId, 'delivered', () => ({
      type: 'effect.intent.delivered',
      deliveryResult: 'delivered',
    }))
  }

  markEffectIntentFailed(effectId: string): void {
    this.transitionEffectIntent(effectId, 'failed', () => ({
      type: 'effect.intent.failed',
      deliveryResult: 'failed',
    }))
  }

  markEffectIntentUnsupported(effectId: string): void {
    this.transitionEffectIntent(effectId, 'unsupported', (existing) => ({
      type: 'effect.intent.unsupported',
      deliveryResult: 'unsupported',
      errorCode: 'unsupported_effect',
      errorMessage: `Unsupported workflow effect kind: ${existing.kind}`,
    }))
  }

  loadSnapshot(): WorkflowKernelSnapshot {
    const definitions = (
      this.context.sqlite
        .prepare('SELECT definition_json FROM workflow_definitions ORDER BY id, version')
        .all() as DefinitionRow[]
    ).map((row) => parse<PublishedWorkflowDefinition>(row.definition_json))

    const tasks = (
      this.context.sqlite
        .prepare(
          `SELECT task_id, project_id, workflow_id, workflow_version, workflow_hash, state_json,
                  version, goal, risk, facts_json, role_bindings_json, supervisor_json,
                  created_at, updated_at
             FROM workflow_tasks
         ORDER BY task_id`
        )
        .all() as TaskRow[]
    ).map(mapTask)

    const evidence = (
      this.context.sqlite
        .prepare(
          `SELECT evidence_id, task_id, kind, ref, summary, data_json,
                  actor_json, role, run_id, participant_run_id, supervisor_run_id, created_at
             FROM workflow_evidence
         ORDER BY created_at, evidence_id`
        )
        .all() as EvidenceRow[]
    ).map(
      (row): EvidenceRecord => ({
        evidenceId: row.evidence_id,
        taskId: row.task_id,
        kind: row.kind,
        ref: row.ref,
        ...(row.summary !== null ? { summary: row.summary } : {}),
        ...(row.data_json !== null ? { data: parse<Record<string, unknown>>(row.data_json) } : {}),
        ...(row.actor_json !== null ? { actor: parse<ActorRef>(row.actor_json) } : {}),
        ...(row.role !== null ? { role: row.role } : {}),
        ...(row.run_id !== null ? { runId: row.run_id } : {}),
        ...(row.participant_run_id !== null ? { participantRunId: row.participant_run_id } : {}),
        ...(row.supervisor_run_id !== null ? { supervisorRunId: row.supervisor_run_id } : {}),
        createdAt: row.created_at,
      })
    )

    const obligations = (
      this.context.sqlite
        .prepare(
          `SELECT obligation_id, task_id, kind, owner_role, summary, blocking, status,
                  created_at, updated_at, satisfied_at, satisfaction_evidence_ids_json,
                  waived_at, waiver_reason, waiver_evidence_refs_json, cancelled_at,
                  cancel_reason, expired_at, expire_reason
             FROM workflow_obligations
         ORDER BY created_at, obligation_id`
        )
        .all() as ObligationRow[]
    ).map(
      (row): ObligationRecord => ({
        obligationId: row.obligation_id,
        taskId: row.task_id,
        kind: row.kind,
        ...(row.owner_role !== null ? { ownerRole: row.owner_role } : {}),
        summary: row.summary,
        blocking: row.blocking === 1,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        ...(row.satisfied_at !== null ? { satisfiedAt: row.satisfied_at } : {}),
        ...(row.satisfaction_evidence_ids_json !== null
          ? { satisfactionEvidenceIds: parse<string[]>(row.satisfaction_evidence_ids_json) }
          : {}),
        ...(row.waived_at !== null ? { waivedAt: row.waived_at } : {}),
        ...(row.waiver_reason !== null ? { waiverReason: row.waiver_reason } : {}),
        ...(row.waiver_evidence_refs_json !== null
          ? { waiverEvidenceRefs: parse<string[]>(row.waiver_evidence_refs_json) }
          : {}),
        ...(row.cancelled_at !== null ? { cancelledAt: row.cancelled_at } : {}),
        ...(row.cancel_reason !== null ? { cancelReason: row.cancel_reason } : {}),
        ...(row.expired_at !== null ? { expiredAt: row.expired_at } : {}),
        ...(row.expire_reason !== null ? { expireReason: row.expire_reason } : {}),
      })
    )

    const events = (
      this.context.sqlite
        .prepare(
          `SELECT event_id, workflow_seq, schema_version, task_id, workflow_id,
                  workflow_version, workflow_hash, type, command_type, command_hash,
                  causation_id, correlation_id, actor_json, role, authority, run_id,
                  supervisor_run_id, participant_run_id, observed_task_version,
                  next_task_version, context_hash, idempotency_key, result, rejection_code,
                  payload_json, event_hash, prev_hash, created_at
             FROM workflow_events
         ORDER BY task_id, workflow_seq, created_at, event_id`
        )
        .all() as EventRow[]
    ).map(
      (row): WorkflowEvent => ({
        eventId: row.event_id,
        workflowSeq: row.workflow_seq,
        schemaVersion: row.schema_version,
        taskId: row.task_id,
        workflow: { id: row.workflow_id, version: row.workflow_version, hash: row.workflow_hash },
        type: row.type,
        ...(row.command_type !== null ? { commandType: row.command_type } : {}),
        ...(row.command_hash !== null ? { commandHash: row.command_hash } : {}),
        ...(row.causation_id !== null ? { causationId: row.causation_id } : {}),
        ...(row.correlation_id !== null ? { correlationId: row.correlation_id } : {}),
        actor: parse<ActorRef>(row.actor_json),
        ...(row.role !== null ? { role: row.role } : {}),
        ...(row.authority !== null ? { authority: row.authority } : {}),
        ...(row.run_id !== null ? { runId: row.run_id } : {}),
        ...(row.supervisor_run_id !== null ? { supervisorRunId: row.supervisor_run_id } : {}),
        ...(row.participant_run_id !== null ? { participantRunId: row.participant_run_id } : {}),
        observedTaskVersion: row.observed_task_version,
        ...(row.next_task_version !== null ? { nextTaskVersion: row.next_task_version } : {}),
        ...(row.context_hash !== null ? { contextHash: row.context_hash } : {}),
        idempotencyKey: row.idempotency_key,
        result: row.result,
        ...(row.rejection_code !== null ? { rejectionCode: row.rejection_code } : {}),
        payload: parse<Record<string, unknown>>(row.payload_json),
        eventHash: row.event_hash,
        ...(row.prev_hash !== null ? { prevHash: row.prev_hash } : {}),
        createdAt: row.created_at,
      })
    )

    const workflowHrcRunMaps = (
      this.context.sqlite
        .prepare(
          `SELECT map_id, workflow_task_id, participant_run_id, supervisor_run_id,
                  hrc_run_id, runtime_id, launch_id, host_session_id, scope_ref, lane_ref,
                  generation, created_at, source
             FROM workflow_hrc_run_maps
         ORDER BY created_at, map_id`
        )
        .all() as WorkflowHrcRunMapRow[]
    ).map(
      (row): WorkflowHrcRunMap => ({
        mapId: row.map_id,
        workflowTaskId: row.workflow_task_id,
        ...(row.participant_run_id !== null ? { participantRunId: row.participant_run_id } : {}),
        ...(row.supervisor_run_id !== null ? { supervisorRunId: row.supervisor_run_id } : {}),
        hrcRunId: row.hrc_run_id,
        ...(row.runtime_id !== null ? { runtimeId: row.runtime_id } : {}),
        ...(row.launch_id !== null ? { launchId: row.launch_id } : {}),
        ...(row.host_session_id !== null ? { hostSessionId: row.host_session_id } : {}),
        ...(row.scope_ref !== null ? { scopeRef: row.scope_ref } : {}),
        ...(row.lane_ref !== null ? { laneRef: row.lane_ref } : {}),
        ...(row.generation !== null ? { generation: row.generation } : {}),
        createdAt: row.created_at,
        source: row.source,
      })
    )

    const effects = (
      this.context.sqlite
        .prepare(
          `SELECT effect_id, task_id, source_event_id, kind, payload_json, idempotency_key,
                  state, created_at, updated_at
             FROM workflow_effect_intents
         ORDER BY created_at, effect_id`
        )
        .all() as EffectRow[]
    ).map(
      (row): EffectIntent => ({
        effectId: row.effect_id,
        taskId: row.task_id,
        sourceEventId: row.source_event_id,
        kind: row.kind,
        payload: parse<Record<string, unknown>>(row.payload_json),
        idempotencyKey: row.idempotency_key,
        state: row.state,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })
    )

    const participantRuns = (
      this.context.sqlite
        .prepare(
          `SELECT run_id, task_id, workflow_json, actor_json, role, status, parent_supervisor_run_id,
                  task_version_at_start, context_hash, created_at
             FROM workflow_participant_runs
         ORDER BY created_at, run_id`
        )
        .all() as ParticipantRunRow[]
    ).map(
      (row): ParticipantRunRecord => ({
        runId: row.run_id,
        kind: 'participant',
        taskId: row.task_id,
        workflow: parse<WorkflowRef>(row.workflow_json),
        actor: parse<ActorRef>(row.actor_json),
        role: row.role,
        status: row.status as ParticipantRunRecord['status'],
        ...(row.parent_supervisor_run_id !== null
          ? { parentSupervisorRunId: row.parent_supervisor_run_id }
          : {}),
        taskVersionAtStart: row.task_version_at_start,
        contextHash: row.context_hash,
        createdAt: row.created_at,
      })
    )

    const supervisorRuns = (
      this.context.sqlite
        .prepare(
          `SELECT run_id, task_id, workflow_json, supervisor_json, autonomy, capabilities_json,
                  harness_json, task_version_at_start, context_hash, created_at, paused, paused_reason
             FROM workflow_supervisor_runs
         ORDER BY created_at, run_id`
        )
        .all() as SupervisorRunRow[]
    ).map(
      (row): SupervisorRunRecord => ({
        runId: row.run_id,
        kind: 'workflow_supervisor',
        taskId: row.task_id,
        workflow: parse<WorkflowRef>(row.workflow_json),
        supervisor: parse<ActorRef>(row.supervisor_json),
        autonomy: row.autonomy,
        capabilities: parse<SupervisorCapabilities>(row.capabilities_json),
        ...(row.harness_json !== null
          ? { harness: parse<Record<string, unknown>>(row.harness_json) }
          : {}),
        taskVersionAtStart: row.task_version_at_start,
        contextHash: row.context_hash,
        createdAt: row.created_at,
        ...(row.paused === 1 ? { paused: true, pausedReason: row.paused_reason ?? undefined } : {}),
      })
    )

    const anomalies = (
      this.context.sqlite
        .prepare(
          `SELECT anomaly_id, task_id, workflow_json, supervisor_run_id, category,
                  state_at_observation_json, task_version, summary, proposed_recovery, created_at
             FROM workflow_anomalies
         ORDER BY created_at, anomaly_id`
        )
        .all() as AnomalyRow[]
    ).map(
      (row): WorkflowAnomaly => ({
        anomalyId: row.anomaly_id,
        taskId: row.task_id,
        workflow: parse<WorkflowRef>(row.workflow_json),
        ...(row.supervisor_run_id !== null ? { supervisorRunId: row.supervisor_run_id } : {}),
        category: row.category,
        stateAtObservation: parse<WorkState>(row.state_at_observation_json),
        taskVersion: row.task_version,
        summary: row.summary,
        ...(row.proposed_recovery !== null ? { proposedRecovery: row.proposed_recovery } : {}),
        createdAt: row.created_at,
      })
    )

    const patchProposals = (
      this.context.sqlite
        .prepare(
          `SELECT proposal_id, task_id, base_workflow_json, proposed_version,
                  source_anomaly_ids_json, patch_kind, patch_json, rationale_summary, status,
                  created_by_json, created_at
             FROM workflow_patch_proposals
         ORDER BY created_at, proposal_id`
        )
        .all() as PatchProposalRow[]
    ).map(
      (row): WorkflowPatchProposal => ({
        proposalId: row.proposal_id,
        taskId: row.task_id,
        baseWorkflow: parse<WorkflowRef>(row.base_workflow_json),
        ...(row.proposed_version !== null ? { proposedVersion: row.proposed_version } : {}),
        sourceAnomalyIds: parse<string[]>(row.source_anomaly_ids_json),
        patchKind: row.patch_kind,
        patch: parse<unknown>(row.patch_json),
        rationaleSummary: row.rationale_summary,
        status: row.status,
        createdBy: parse<ActorRef>(row.created_by_json),
        createdAt: row.created_at,
      })
    )

    const idempotency = (
      this.context.sqlite
        .prepare(
          `SELECT idempotency_key, fingerprint, result_json
             FROM workflow_idempotency_records
         ORDER BY idempotency_key`
        )
        .all() as IdempotencyRow[]
    ).map((row): { key: string; record: WorkflowIdempotencyRecord } => ({
      key: row.idempotency_key,
      record: {
        fingerprint: row.fingerprint,
        result: parse<unknown>(row.result_json),
      },
    }))

    const contextHashRows = this.context.sqlite
      .prepare(
        `SELECT task_id, context_hash
           FROM workflow_context_hashes
       ORDER BY task_id, context_hash`
      )
      .all() as ContextHashRow[]
    const hashesByTask = new Map<string, string[]>()
    for (const row of contextHashRows) {
      hashesByTask.set(row.task_id, [...(hashesByTask.get(row.task_id) ?? []), row.context_hash])
    }

    const sequenceRow = this.context.sqlite
      .prepare("SELECT value_json FROM workflow_runtime_meta WHERE key = 'sequence'")
      .get() as MetaRow | undefined

    return {
      definitions,
      tasks,
      evidence,
      obligations,
      effects,
      events,
      workflowHrcRunMaps,
      supervisorRuns,
      participantRuns,
      anomalies,
      patchProposals,
      idempotency,
      contextHashes: [...hashesByTask.entries()].map(([taskId, hashes]) => ({ taskId, hashes })),
      sequence: sequenceRow === undefined ? 0 : parse<number>(sequenceRow.value_json),
    }
  }

  saveSnapshot(snapshot: WorkflowKernelSnapshot): void {
    this.context.sqlite.transaction(() => {
      this.truncateAllSnapshotTables()
      const now = new Date().toISOString()
      this.writeDefinitions(snapshot.definitions, now)
      this.writeTasks(snapshot.tasks)
      this.writeEvidence(snapshot.evidence)
      this.writeObligations(snapshot.obligations)
      this.writeEvents(snapshot.events)
      this.writeHrcRunMaps(snapshot.workflowHrcRunMaps ?? [])
      this.writeEffects(snapshot.effects)
      this.writeParticipantRuns(snapshot.participantRuns)
      this.writeSupervisorRuns(snapshot.supervisorRuns)
      this.writeAnomalies(snapshot.anomalies)
      this.writePatchProposals(snapshot.patchProposals)
      this.writeIdempotency(snapshot.idempotency, now)
      this.writeContextHashes(snapshot.contextHashes)
      this.writeRuntimeSequence(snapshot.sequence)
    })()
  }

  private truncateAllSnapshotTables(): void {
    const tables = [
      'workflow_context_hashes',
      'workflow_idempotency_records',
      'workflow_patch_proposals',
      'workflow_anomalies',
      'workflow_supervisor_runs',
      'workflow_participant_runs',
      'workflow_hrc_run_maps',
      'workflow_effect_intents',
      'workflow_events',
      'workflow_obligations',
      'workflow_evidence',
      'workflow_tasks',
      'workflow_definitions',
      'workflow_runtime_meta',
    ]
    for (const table of tables) {
      this.context.sqlite.prepare(`DELETE FROM ${table}`).run()
    }
  }

  private writeDefinitions(definitions: WorkflowKernelSnapshot['definitions'], now: string): void {
    const stmt = this.context.sqlite.prepare(
      `INSERT INTO workflow_definitions (id, version, hash, definition_json, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    for (const definition of definitions) {
      stmt.run(definition.id, definition.version, definition.hash, stringify(definition), now)
    }
  }

  private writeTasks(tasks: WorkflowKernelSnapshot['tasks']): void {
    const stmt = this.context.sqlite.prepare(
      `INSERT INTO workflow_tasks (
         task_id, project_id, workflow_id, workflow_version, workflow_hash, state_json, version,
         goal, risk, facts_json, role_bindings_json, supervisor_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const task of tasks) {
      stmt.run(
        task.taskId,
        task.projectId,
        task.workflow.id,
        task.workflow.version,
        task.workflow.hash,
        stringify(task.state),
        task.version,
        task.goal,
        task.risk ?? null,
        task.facts === undefined ? null : stringify(task.facts),
        stringify(task.roleBindings),
        task.supervisor === undefined ? null : stringify(task.supervisor),
        task.createdAt,
        task.updatedAt
      )
    }
  }

  private writeEvidence(evidence: WorkflowKernelSnapshot['evidence']): void {
    const stmt = this.context.sqlite.prepare(
      `INSERT INTO workflow_evidence (evidence_id, task_id, kind, ref, summary, data_json,
       actor_json, role, run_id, participant_run_id, supervisor_run_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const item of evidence) {
      stmt.run(
        item.evidenceId,
        item.taskId,
        item.kind,
        item.ref,
        item.summary ?? null,
        item.data === undefined ? null : stringify(item.data),
        item.actor === undefined ? null : stringify(item.actor),
        item.role ?? null,
        item.runId ?? null,
        item.participantRunId ?? null,
        item.supervisorRunId ?? null,
        item.createdAt
      )
    }
  }

  private writeObligations(obligations: WorkflowKernelSnapshot['obligations']): void {
    const stmt = this.context.sqlite.prepare(
      `INSERT INTO workflow_obligations (
         obligation_id, task_id, kind, owner_role, summary, blocking, status, created_at,
         updated_at, satisfied_at, satisfaction_evidence_ids_json, waived_at, waiver_reason,
         waiver_evidence_refs_json, cancelled_at, cancel_reason, expired_at, expire_reason
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const obligation of obligations) {
      stmt.run(
        obligation.obligationId,
        obligation.taskId,
        obligation.kind,
        obligation.ownerRole ?? null,
        obligation.summary,
        obligation.blocking ? 1 : 0,
        obligation.status,
        obligation.createdAt,
        obligation.updatedAt,
        obligation.satisfiedAt ?? null,
        obligation.satisfactionEvidenceIds === undefined
          ? null
          : stringify(obligation.satisfactionEvidenceIds),
        obligation.waivedAt ?? null,
        obligation.waiverReason ?? null,
        obligation.waiverEvidenceRefs === undefined
          ? null
          : stringify(obligation.waiverEvidenceRefs),
        obligation.cancelledAt ?? null,
        obligation.cancelReason ?? null,
        obligation.expiredAt ?? null,
        obligation.expireReason ?? null
      )
    }
  }

  private writeEvents(events: WorkflowKernelSnapshot['events']): void {
    const stmt = this.context.sqlite.prepare(
      `INSERT INTO workflow_events (
         event_id, workflow_seq, schema_version, task_id, workflow_id, workflow_version,
         workflow_hash, type, command_type, command_hash, causation_id, correlation_id,
         actor_json, role, authority, run_id, supervisor_run_id, participant_run_id,
         observed_task_version, next_task_version, context_hash, idempotency_key, result,
         rejection_code, payload_json, event_hash, prev_hash, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const event of events) {
      stmt.run(
        event.eventId,
        event.workflowSeq,
        event.schemaVersion,
        event.taskId,
        event.workflow.id,
        event.workflow.version,
        event.workflow.hash,
        event.type,
        event.commandType ?? null,
        event.commandHash ?? null,
        event.causationId ?? null,
        event.correlationId ?? null,
        stringify(event.actor),
        event.role ?? null,
        event.authority ?? null,
        event.runId ?? null,
        event.supervisorRunId ?? null,
        event.participantRunId ?? null,
        event.observedTaskVersion,
        event.nextTaskVersion ?? null,
        event.contextHash ?? null,
        event.idempotencyKey,
        event.result,
        event.rejectionCode ?? null,
        stringify(event.payload),
        event.eventHash,
        event.prevHash ?? null,
        event.createdAt
      )
    }
  }

  private writeHrcRunMaps(maps: NonNullable<WorkflowKernelSnapshot['workflowHrcRunMaps']>): void {
    const stmt = this.context.sqlite.prepare(
      `INSERT INTO workflow_hrc_run_maps (
         map_id, workflow_task_id, participant_run_id, supervisor_run_id, hrc_run_id,
         runtime_id, launch_id, host_session_id, scope_ref, lane_ref, generation, created_at,
         source
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const map of maps) {
      stmt.run(
        map.mapId,
        map.workflowTaskId,
        map.participantRunId ?? null,
        map.supervisorRunId ?? null,
        map.hrcRunId,
        map.runtimeId ?? null,
        map.launchId ?? null,
        map.hostSessionId ?? null,
        map.scopeRef ?? null,
        map.laneRef ?? null,
        map.generation ?? null,
        map.createdAt,
        map.source
      )
    }
  }

  private writeEffects(effects: WorkflowKernelSnapshot['effects']): void {
    const stmt = this.context.sqlite.prepare(
      `INSERT INTO workflow_effect_intents (
         effect_id, task_id, source_event_id, kind, payload_json, idempotency_key, state,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const effect of effects) {
      stmt.run(
        effect.effectId,
        effect.taskId,
        effect.sourceEventId,
        effect.kind,
        stringify(effect.payload),
        effect.idempotencyKey,
        effect.state,
        effect.createdAt,
        effect.updatedAt
      )
    }
  }

  private writeParticipantRuns(runs: WorkflowKernelSnapshot['participantRuns']): void {
    const stmt = this.context.sqlite.prepare(
      `INSERT INTO workflow_participant_runs (
         run_id, task_id, workflow_json, actor_json, role, status, parent_supervisor_run_id,
         task_version_at_start, context_hash, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const run of runs) {
      stmt.run(
        run.runId,
        run.taskId,
        stringify(run.workflow),
        stringify(run.actor),
        run.role,
        run.status ?? 'launched',
        run.parentSupervisorRunId ?? null,
        run.taskVersionAtStart,
        run.contextHash,
        run.createdAt
      )
    }
  }

  private writeSupervisorRuns(runs: WorkflowKernelSnapshot['supervisorRuns']): void {
    const stmt = this.context.sqlite.prepare(
      `INSERT INTO workflow_supervisor_runs (
         run_id, task_id, workflow_json, supervisor_json, autonomy, capabilities_json,
         harness_json, task_version_at_start, context_hash, created_at, paused, paused_reason
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const run of runs) {
      stmt.run(
        run.runId,
        run.taskId,
        stringify(run.workflow),
        stringify(run.supervisor),
        run.autonomy,
        stringify(run.capabilities),
        run.harness === undefined ? null : stringify(run.harness),
        run.taskVersionAtStart,
        run.contextHash,
        run.createdAt,
        run.paused === true ? 1 : 0,
        run.pausedReason ?? null
      )
    }
  }

  private writeAnomalies(anomalies: WorkflowKernelSnapshot['anomalies']): void {
    const stmt = this.context.sqlite.prepare(
      `INSERT INTO workflow_anomalies (
         anomaly_id, task_id, workflow_json, supervisor_run_id, category,
         state_at_observation_json, task_version, summary, proposed_recovery, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const anomaly of anomalies) {
      stmt.run(
        anomaly.anomalyId,
        anomaly.taskId,
        stringify(anomaly.workflow),
        anomaly.supervisorRunId ?? null,
        anomaly.category,
        stringify(anomaly.stateAtObservation),
        anomaly.taskVersion,
        anomaly.summary,
        anomaly.proposedRecovery ?? null,
        anomaly.createdAt
      )
    }
  }

  private writePatchProposals(proposals: WorkflowKernelSnapshot['patchProposals']): void {
    const stmt = this.context.sqlite.prepare(
      `INSERT INTO workflow_patch_proposals (
         proposal_id, task_id, base_workflow_json, proposed_version, source_anomaly_ids_json,
         patch_kind, patch_json, rationale_summary, status, created_by_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const proposal of proposals) {
      stmt.run(
        proposal.proposalId,
        proposal.taskId,
        stringify(proposal.baseWorkflow),
        proposal.proposedVersion ?? null,
        stringify(proposal.sourceAnomalyIds),
        proposal.patchKind,
        stringify(proposal.patch),
        proposal.rationaleSummary,
        proposal.status,
        stringify(proposal.createdBy),
        proposal.createdAt
      )
    }
  }

  private writeIdempotency(entries: WorkflowKernelSnapshot['idempotency'], now: string): void {
    const stmt = this.context.sqlite.prepare(
      `INSERT INTO workflow_idempotency_records (idempotency_key, fingerprint, result_json, created_at)
       VALUES (?, ?, ?, ?)`
    )
    for (const entry of entries) {
      stmt.run(entry.key, entry.record.fingerprint, stringify(entry.record.result), now)
    }
  }

  private writeContextHashes(entries: WorkflowKernelSnapshot['contextHashes']): void {
    const stmt = this.context.sqlite.prepare(
      'INSERT INTO workflow_context_hashes (task_id, context_hash) VALUES (?, ?)'
    )
    for (const entry of entries) {
      for (const hash of entry.hashes) {
        stmt.run(entry.taskId, hash)
      }
    }
  }

  private writeRuntimeSequence(sequence: WorkflowKernelSnapshot['sequence']): void {
    this.context.sqlite
      .prepare('INSERT INTO workflow_runtime_meta (key, value_json) VALUES (?, ?)')
      .run('sequence', stringify(sequence))
  }
}
