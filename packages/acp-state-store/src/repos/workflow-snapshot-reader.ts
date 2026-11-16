import type {
  ActorRef,
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

import type { SqliteDatabase } from '../sqlite.js'
import { type EffectRow, mapEffect } from './workflow-effect-row.js'

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

function parse<T>(value: string): T {
  return JSON.parse(value) as T
}

function mapTask(row: TaskRow): WorkflowTask {
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
    ...(row.risk !== null ? { risk: row.risk } : {}),
    ...(facts !== undefined ? { facts } : {}),
    roleBindings: parse<WorkflowTask['roleBindings']>(row.role_bindings_json),
    ...(supervisor !== undefined ? { supervisor } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function loadWorkflowSnapshot(sqlite: SqliteDatabase): WorkflowKernelSnapshot {
  const definitions = (
    sqlite
      .prepare('SELECT definition_json FROM workflow_definitions ORDER BY id, version')
      .all() as DefinitionRow[]
  ).map((row) => parse<PublishedWorkflowDefinition>(row.definition_json))

  const tasks = (
    sqlite
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
    sqlite
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
    sqlite
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
    sqlite
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
    sqlite
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
    sqlite
      .prepare(
        `SELECT effect_id, task_id, source_event_id, kind, payload_json, idempotency_key,
                state, created_at, updated_at
           FROM workflow_effect_intents
       ORDER BY created_at, effect_id`
      )
      .all() as EffectRow[]
  ).map(mapEffect)

  const participantRuns = (
    sqlite
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
    sqlite
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
    sqlite
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
    sqlite
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
    sqlite
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

  const contextHashRows = sqlite
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

  const sequenceRow = sqlite
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
