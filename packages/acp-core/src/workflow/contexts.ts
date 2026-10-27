import { hashValue } from '../internal/canonical-json.js'
import type { createKernelState } from './kernel-state.js'
import type { createTransitionPolicy } from './transition-policy.js'
import type {
  ActorRef,
  ParticipantRunRecord,
  SupervisorBinding,
  SupervisorCapabilities,
  WorkflowTask,
} from './types.js'
import { clone } from './value-semantics.js'

export function createContexts(
  {
    tasks,
    getDefinitionForTask,
    evidence,
    obligations,
    rememberContextHash,
    participantRuns,
    effects,
    anomalies,
  }: Pick<
    ReturnType<typeof createKernelState>,
    | 'tasks'
    | 'getDefinitionForTask'
    | 'evidence'
    | 'obligations'
    | 'rememberContextHash'
    | 'participantRuns'
    | 'effects'
    | 'anomalies'
  >,
  {
    evaluateTransition,
    buildTransitionAffordance,
  }: Pick<
    ReturnType<typeof createTransitionPolicy>,
    'evaluateTransition' | 'buildTransitionAffordance'
  >
) {
  function contextHashFor<T extends Record<string, unknown>>(context: T): string {
    const copy: Record<string, unknown> = { ...context, contextHash: undefined }
    return hashValue(copy)
  }

  const taskContext = (task: WorkflowTask) => ({
    id: task.taskId,
    projectId: task.projectId,
    workflow: task.workflow,
    state: task.state,
    version: task.version,
    goal: task.goal,
    ...(task.risk ? { risk: task.risk } : {}),
  })

  const sealContext = (taskId: string, context: Record<string, unknown>) => {
    const hash = contextHashFor(context)
    context['contextHash'] = hash
    rememberContextHash(taskId, hash)
    return clone(context)
  }

  const participantObjective = (
    taskId: string,
    role: string,
    allowedTransitions: Record<string, unknown>[]
  ) => ({
    roleObjective: {
      current: `Act as ${role} for the current workflow state.`,
      doneWhen: allowedTransitions.map(
        (transition) => `Apply ${transition['id']} when requirements are met.`
      ),
    },
    assignedObligations: (obligations.get(taskId) ?? []).filter(
      (obligation) => obligation.ownerRole === role
    ),
    relevantEvidence: evidence.get(taskId) ?? [],
    allowedTransitions,
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
      task: taskContext(task),
      run: {
        id: request.runId,
        actor: request.actor,
        role: request.role,
        sessionRef: request.sessionRef,
        idempotencyPrefix: request.idempotencyPrefix,
      },
      ...participantObjective(task.taskId, request.role, allowedTransitions),
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
    return sealContext(task.taskId, context)
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
    const addControlAction = (
      action: { type: string; [key: string]: unknown },
      key: string,
      checkVersion: boolean,
      projection: Record<string, unknown> = {}
    ) => {
      allowedControlActions.push({
        type: action.type,
        ...projection,
        command: makeCommand('acp.workflow.controlAction', {
          taskId: task.taskId,
          action,
          ...(checkVersion ? { expectedTaskVersion: task.version } : {}),
          idempotencyKey: `${request.idempotencyPrefix}:control:${key}:v${task.version}`,
        }),
      })
    }
    if (request.capabilities.launchRuns) {
      addControlAction(
        { type: 'launch_participant_run', role: '<role>', actor: '<actor>' },
        'launch',
        true
      )
    }
    if (request.capabilities.createObligations) {
      addControlAction(
        { type: 'create_obligation', kind: '<kind>', summary: '<summary>' },
        'obligation',
        true
      )
    }
    if (request.capabilities.satisfyObligations) {
      for (const obligation of (obligations.get(task.taskId) ?? []).filter(
        (candidate) => candidate.status === 'open'
      )) {
        addControlAction(
          { type: 'satisfy_obligation', obligationId: obligation.obligationId },
          `satisfy:${obligation.obligationId}`,
          true,
          { obligationId: obligation.obligationId }
        )
      }
    }
    if (request.capabilities.proposeWorkflowPatches) {
      addControlAction({ type: 'propose_workflow_patch', patchKind: '<patchKind>' }, 'patch', true)
    }
    if (request.capabilities.attachEvidence) {
      addControlAction(
        {
          type: 'attach_evidence',
          evidence: [{ kind: '<kind>', ref: '<ref>' }],
        },
        'evidence',
        true
      )
    }
    if (request.capabilities.applySupervisorTransitions) {
      addControlAction(
        {
          type: 'apply_transition',
          transitionId: '<transitionId>',
          evidenceRefs: ['<evidenceRef>'],
        },
        'transition',
        true
      )
    }
    if (request.capabilities.escalate) {
      addControlAction(
        {
          type: 'escalate',
          reason: '<reason>',
          severity: '<severity>',
        },
        'escalate',
        true
      )
    }
    if (request.capabilities.pauseSupervision) {
      addControlAction({ type: 'pause_supervision', reason: '<reason>' }, 'pause', false)
      addControlAction({ type: 'unpause_supervision' }, 'unpause', false)
    }
    const context: Record<string, unknown> = {
      schemaVersion: 1,
      task: { ...taskContext(task), ...(task.facts ? { facts: task.facts } : {}) },
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
        ...Object.fromEntries(
          Object.entries({
            launchParticipantRun: 'launch_participant_run',
            sendInputToRun: 'send_input_to_run',
            createObligation: 'create_obligation',
            satisfyObligation: 'satisfy_obligation',
            attachEvidence: 'attach_evidence',
            applyTransition: 'apply_transition',
            escalate: 'escalate',
            createChildTask: 'create_child_task',
            requestHumanInput: 'request_human_input',
            proposeWorkflowPatch: 'propose_workflow_patch',
            pauseSupervision: 'pause_supervision',
            unpauseSupervision: 'unpause_supervision',
          }).map(([name, action]) => [
            name,
            makeCommand('acp.workflow.controlAction', { taskId: task.taskId, action }),
          ])
        ),
      },
    }
    return sealContext(task.taskId, context)
  }

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
      task: taskContext(task),
      run: {
        id: run.runId,
        actor: run.actor,
        role: run.role,
      },
      ...participantObjective(task.taskId, run.role, allowedTransitions),
    }
    return sealContext(task.taskId, context)
  }

  return { buildParticipantRunContext, compileSupervisorContext, compileParticipantContext }
}

export function makeCommand(name: string, args: Record<string, unknown>): Record<string, unknown> {
  return { name, args }
}
