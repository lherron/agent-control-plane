import { actorEquals, applyStatePatch, reject, validateWorkState } from './domain-policy.js'
import type { createJournal } from './journal.js'
import type { createKernelState } from './kernel-state.js'
import type { createTransitionPolicy } from './transition-policy.js'
import type {
  ActorRef,
  EvidenceRecord,
  WorkflowControlAction,
  WorkflowResult,
  WorkflowTask,
} from './types.js'
import { clone } from './value-semantics.js'

export function createSupervisorTransitions(
  {
    tasks,
    now,
    evidence,
    participantRuns,
    getDefinitionForTask,
    clearContextHashes,
  }: Pick<
    ReturnType<typeof createKernelState>,
    'tasks' | 'now' | 'evidence' | 'participantRuns' | 'getDefinitionForTask' | 'clearContextHashes'
  >,
  { appendEvent }: Pick<ReturnType<typeof createJournal>, 'appendEvent'>,
  {
    evaluateTransition,
    materializeTransitionEffect,
  }: Pick<
    ReturnType<typeof createTransitionPolicy>,
    'evaluateTransition' | 'materializeTransitionEffect'
  >
) {
  const applySupervisorTransition = (
    task: WorkflowTask,
    action: Extract<WorkflowControlAction, { type: 'apply_transition' }>,
    request: { supervisorRunId: string },
    idempotencyKey: string
  ): WorkflowResult<{ task: WorkflowTask }> => {
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
    if (action.expectedTaskVersion !== undefined && action.expectedTaskVersion !== task.version) {
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
        return reject('authority_not_granted', `Participant run ${prunId} not found on this task`)
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
      if (boundActor === undefined || boundActor === null || !actorEquals(boundActor, prun.actor)) {
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
    if (
      transitionError !== undefined &&
      transitionError.code !== 'role_not_allowed' &&
      transitionError.code !== 'role_not_bound'
    ) {
      return { ok: false, error: transitionError }
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
  return { applySupervisorTransition }
}
