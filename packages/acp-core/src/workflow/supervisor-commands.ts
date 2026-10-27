import { hashValue } from '../internal/canonical-json.js'
import type { createContexts } from './contexts.js'
import { actorEquals, reject, stateMatches } from './domain-policy.js'
import type { createEvidenceCommands } from './evidence-commands.js'
import type { createJournal } from './journal.js'
import type { createKernelState } from './kernel-state.js'
import type { createObligationCommands } from './obligation-commands.js'
import type { createSupervisorTransitions } from './supervisor-transitions.js'
import type {
  ActorRef,
  EvidenceRecord,
  ObligationRecord,
  ParticipantRunRecord,
  SupervisorBinding,
  SupervisorCapabilities,
  SupervisorRunRecord,
  WorkflowAnomaly,
  WorkflowControlAction,
  WorkflowPatchProposal,
  WorkflowRejection,
  WorkflowResult,
  WorkflowTask,
} from './types.js'
import { clone } from './value-semantics.js'

export function createSupervisorCommands(
  {
    withIdempotency,
    appendEvent,
    createEffectIntent,
  }: Pick<
    ReturnType<typeof createJournal>,
    'withIdempotency' | 'appendEvent' | 'createEffectIntent'
  >,
  {
    tasks,
    nextId,
    now,
    supervisorRuns,
    currentContextHashes,
    participantRuns,
    getDefinitionForTask,
    obligations,
    clearContextHashes,
    anomalies,
    patchProposals,
  }: Pick<
    ReturnType<typeof createKernelState>,
    | 'tasks'
    | 'nextId'
    | 'now'
    | 'supervisorRuns'
    | 'currentContextHashes'
    | 'participantRuns'
    | 'getDefinitionForTask'
    | 'obligations'
    | 'clearContextHashes'
    | 'anomalies'
    | 'patchProposals'
  >,
  { compileSupervisorContext }: Pick<ReturnType<typeof createContexts>, 'compileSupervisorContext'>,
  { addEvidence }: Pick<ReturnType<typeof createEvidenceCommands>, 'addEvidence'>,
  {
    resolveObligation,
    recordWaiver,
  }: Pick<ReturnType<typeof createObligationCommands>, 'resolveObligation' | 'recordWaiver'>,
  {
    applySupervisorTransition,
  }: Pick<ReturnType<typeof createSupervisorTransitions>, 'applySupervisorTransition'>
) {
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

  const performControlAction = (
    task: WorkflowTask,
    supervisorRunList: SupervisorRunRecord[],
    supervisorRun: SupervisorRunRecord,
    action: WorkflowControlAction,
    request: { supervisorRunId: string },
    idempotencyKey: string
  ): WorkflowResult<{
    task: WorkflowTask
    obligation?: ObligationRecord | undefined
    participantRun?: ParticipantRunRecord | undefined
    anomaly?: WorkflowAnomaly | undefined
    proposal?: WorkflowPatchProposal | undefined
    evidence?: EvidenceRecord[] | undefined
  }> => {
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
      const index = list.findIndex((obligation) => obligation.obligationId === action.obligationId)
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
      const hasWaitingResumeTransition = Object.values(definition.transitions).some((transition) =>
        stateMatches(task.state, transition.from)
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
      return recordWaiver(
        resolved,
        {
          ...action,
          actor: supervisorRun.supervisor,
          supervisorRunId: request.supervisorRunId,
        },
        idempotencyKey
      )
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
      patchProposals.set(task.taskId, [...(patchProposals.get(task.taskId) ?? []), clone(proposal)])
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
      return applySupervisorTransition(task, action, request, idempotencyKey)
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
  }

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
      return performControlAction(
        task,
        supervisorRunList,
        supervisorRun,
        action,
        request,
        idempotencyKey
      )
    })

  return { startSupervisorRun, submitControlAction }
}
