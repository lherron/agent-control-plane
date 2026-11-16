import type { WorkflowKernelSnapshot } from 'acp-core'

import type { SqliteDatabase } from '../sqlite.js'

export function saveWorkflowSnapshot(
  sqlite: SqliteDatabase,
  snapshot: WorkflowKernelSnapshot
): void {
  sqlite.transaction(() => {
    truncateAllSnapshotTables(sqlite)
    const now = new Date().toISOString()
    writeDefinitions(sqlite, snapshot.definitions, now)
    writeTasks(sqlite, snapshot.tasks)
    writeEvidence(sqlite, snapshot.evidence)
    writeObligations(sqlite, snapshot.obligations)
    writeEvents(sqlite, snapshot.events)
    writeHrcRunMaps(sqlite, snapshot.workflowHrcRunMaps ?? [])
    writeEffects(sqlite, snapshot.effects)
    writeParticipantRuns(sqlite, snapshot.participantRuns)
    writeSupervisorRuns(sqlite, snapshot.supervisorRuns)
    writeAnomalies(sqlite, snapshot.anomalies)
    writePatchProposals(sqlite, snapshot.patchProposals)
    writeIdempotency(sqlite, snapshot.idempotency, now)
    writeContextHashes(sqlite, snapshot.contextHashes)
    writeRuntimeSequence(sqlite, snapshot.sequence)
  })()
}

function truncateAllSnapshotTables(sqlite: SqliteDatabase): void {
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
    sqlite.prepare(`DELETE FROM ${table}`).run()
  }
}

function writeDefinitions(
  sqlite: SqliteDatabase,
  definitions: WorkflowKernelSnapshot['definitions'],
  now: string
): void {
  const stmt = sqlite.prepare(
    `INSERT INTO workflow_definitions (id, version, hash, definition_json, created_at)
     VALUES (?, ?, ?, ?, ?)`
  )
  for (const definition of definitions) {
    stmt.run(definition.id, definition.version, definition.hash, JSON.stringify(definition), now)
  }
}

function writeTasks(sqlite: SqliteDatabase, tasks: WorkflowKernelSnapshot['tasks']): void {
  const stmt = sqlite.prepare(
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
      JSON.stringify(task.state),
      task.version,
      task.goal,
      task.risk ?? null,
      task.facts === undefined ? null : JSON.stringify(task.facts),
      JSON.stringify(task.roleBindings),
      task.supervisor === undefined ? null : JSON.stringify(task.supervisor),
      task.createdAt,
      task.updatedAt
    )
  }
}

function writeEvidence(sqlite: SqliteDatabase, evidence: WorkflowKernelSnapshot['evidence']): void {
  const stmt = sqlite.prepare(
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
      item.data === undefined ? null : JSON.stringify(item.data),
      item.actor === undefined ? null : JSON.stringify(item.actor),
      item.role ?? null,
      item.runId ?? null,
      item.participantRunId ?? null,
      item.supervisorRunId ?? null,
      item.createdAt
    )
  }
}

function writeObligations(
  sqlite: SqliteDatabase,
  obligations: WorkflowKernelSnapshot['obligations']
): void {
  const stmt = sqlite.prepare(
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
        : JSON.stringify(obligation.satisfactionEvidenceIds),
      obligation.waivedAt ?? null,
      obligation.waiverReason ?? null,
      obligation.waiverEvidenceRefs === undefined
        ? null
        : JSON.stringify(obligation.waiverEvidenceRefs),
      obligation.cancelledAt ?? null,
      obligation.cancelReason ?? null,
      obligation.expiredAt ?? null,
      obligation.expireReason ?? null
    )
  }
}

function writeEvents(sqlite: SqliteDatabase, events: WorkflowKernelSnapshot['events']): void {
  const stmt = sqlite.prepare(
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
      JSON.stringify(event.actor),
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
      JSON.stringify(event.payload),
      event.eventHash,
      event.prevHash ?? null,
      event.createdAt
    )
  }
}

function writeHrcRunMaps(
  sqlite: SqliteDatabase,
  maps: NonNullable<WorkflowKernelSnapshot['workflowHrcRunMaps']>
): void {
  const stmt = sqlite.prepare(
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

function writeEffects(sqlite: SqliteDatabase, effects: WorkflowKernelSnapshot['effects']): void {
  const stmt = sqlite.prepare(
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
      JSON.stringify(effect.payload),
      effect.idempotencyKey,
      effect.state,
      effect.createdAt,
      effect.updatedAt
    )
  }
}

function writeParticipantRuns(
  sqlite: SqliteDatabase,
  runs: WorkflowKernelSnapshot['participantRuns']
): void {
  const stmt = sqlite.prepare(
    `INSERT INTO workflow_participant_runs (
       run_id, task_id, workflow_json, actor_json, role, status, parent_supervisor_run_id,
       task_version_at_start, context_hash, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  for (const run of runs) {
    stmt.run(
      run.runId,
      run.taskId,
      JSON.stringify(run.workflow),
      JSON.stringify(run.actor),
      run.role,
      run.status ?? 'launched',
      run.parentSupervisorRunId ?? null,
      run.taskVersionAtStart,
      run.contextHash,
      run.createdAt
    )
  }
}

function writeSupervisorRuns(
  sqlite: SqliteDatabase,
  runs: WorkflowKernelSnapshot['supervisorRuns']
): void {
  const stmt = sqlite.prepare(
    `INSERT INTO workflow_supervisor_runs (
       run_id, task_id, workflow_json, supervisor_json, autonomy, capabilities_json,
       harness_json, task_version_at_start, context_hash, created_at, paused, paused_reason
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  for (const run of runs) {
    stmt.run(
      run.runId,
      run.taskId,
      JSON.stringify(run.workflow),
      JSON.stringify(run.supervisor),
      run.autonomy,
      JSON.stringify(run.capabilities),
      run.harness === undefined ? null : JSON.stringify(run.harness),
      run.taskVersionAtStart,
      run.contextHash,
      run.createdAt,
      run.paused === true ? 1 : 0,
      run.pausedReason ?? null
    )
  }
}

function writeAnomalies(
  sqlite: SqliteDatabase,
  anomalies: WorkflowKernelSnapshot['anomalies']
): void {
  const stmt = sqlite.prepare(
    `INSERT INTO workflow_anomalies (
       anomaly_id, task_id, workflow_json, supervisor_run_id, category,
       state_at_observation_json, task_version, summary, proposed_recovery, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  for (const anomaly of anomalies) {
    stmt.run(
      anomaly.anomalyId,
      anomaly.taskId,
      JSON.stringify(anomaly.workflow),
      anomaly.supervisorRunId ?? null,
      anomaly.category,
      JSON.stringify(anomaly.stateAtObservation),
      anomaly.taskVersion,
      anomaly.summary,
      anomaly.proposedRecovery ?? null,
      anomaly.createdAt
    )
  }
}

function writePatchProposals(
  sqlite: SqliteDatabase,
  proposals: WorkflowKernelSnapshot['patchProposals']
): void {
  const stmt = sqlite.prepare(
    `INSERT INTO workflow_patch_proposals (
       proposal_id, task_id, base_workflow_json, proposed_version, source_anomaly_ids_json,
       patch_kind, patch_json, rationale_summary, status, created_by_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  for (const proposal of proposals) {
    stmt.run(
      proposal.proposalId,
      proposal.taskId,
      JSON.stringify(proposal.baseWorkflow),
      proposal.proposedVersion ?? null,
      JSON.stringify(proposal.sourceAnomalyIds),
      proposal.patchKind,
      JSON.stringify(proposal.patch),
      proposal.rationaleSummary,
      proposal.status,
      JSON.stringify(proposal.createdBy),
      proposal.createdAt
    )
  }
}

function writeIdempotency(
  sqlite: SqliteDatabase,
  entries: WorkflowKernelSnapshot['idempotency'],
  now: string
): void {
  const stmt = sqlite.prepare(
    `INSERT INTO workflow_idempotency_records (idempotency_key, fingerprint, result_json, created_at)
     VALUES (?, ?, ?, ?)`
  )
  for (const entry of entries) {
    stmt.run(entry.key, entry.record.fingerprint, JSON.stringify(entry.record.result), now)
  }
}

function writeContextHashes(
  sqlite: SqliteDatabase,
  entries: WorkflowKernelSnapshot['contextHashes']
): void {
  const stmt = sqlite.prepare(
    'INSERT INTO workflow_context_hashes (task_id, context_hash) VALUES (?, ?)'
  )
  for (const entry of entries) {
    for (const hash of entry.hashes) {
      stmt.run(entry.taskId, hash)
    }
  }
}

function writeRuntimeSequence(
  sqlite: SqliteDatabase,
  sequence: WorkflowKernelSnapshot['sequence']
): void {
  sqlite
    .prepare('INSERT INTO workflow_runtime_meta (key, value_json) VALUES (?, ?)')
    .run('sequence', JSON.stringify(sequence))
}
