import { makeCommand } from './contexts.js'
import { actorEquals, stateMatches } from './domain-policy.js'
import type { createJournal } from './journal.js'
import type { createKernelState } from './kernel-state.js'
import type {
  ActorRef,
  BuiltInCondition,
  EffectTemplate,
  EvidenceInput,
  ObligationRecord,
  Requirement,
  TransitionSpec,
  WorkflowEvent,
  WorkflowRejection,
  WorkflowTask,
} from './types.js'
import { clone } from './value-semantics.js'

export function createTransitionPolicy(
  {
    obligations,
    getDefinitionForTask,
    nextId,
    now,
  }: Pick<
    ReturnType<typeof createKernelState>,
    'obligations' | 'getDefinitionForTask' | 'nextId' | 'now'
  >,
  { createEffectIntent }: Pick<ReturnType<typeof createJournal>, 'createEffectIntent'>
) {
  const RISK_ORDER: Record<string, number> = { low: 1, medium: 2, high: 3 }

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
    let payload: Record<string, unknown>
    if (template.type === 'declare_handoff') {
      payload = {
        toRole: template.toRole,
        kind: template.kind,
        ...(template.reason ? { reason: template.reason } : {}),
      }
    } else if (template.type === 'wake_role_session') {
      payload = { role: template.role, ...(template.reason ? { reason: template.reason } : {}) }
    } else if (template.type === 'create_obligation') {
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
      payload = {
        obligationId: obligation.obligationId,
        kind: obligation.kind,
        ...(obligation.ownerRole ? { ownerRole: obligation.ownerRole } : {}),
        blocking: obligation.blocking,
      }
    } else {
      payload = clone(template) as Record<string, unknown>
    }
    createEffectIntent(
      task,
      transitionEvent.eventId,
      idempotencyKey,
      template.type,
      payload,
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

  return { evaluateTransition, buildTransitionAffordance, materializeTransitionEffect }
}
