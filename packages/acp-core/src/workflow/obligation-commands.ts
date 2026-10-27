import { actorEquals, reject, stateMatches } from './domain-policy.js'
import type { createJournal } from './journal.js'
import type { createKernelState } from './kernel-state.js'
import type { ActorRef, ObligationRecord, WorkflowResult, WorkflowTask } from './types.js'
import { clone } from './value-semantics.js'

export function createObligationCommands(
  {
    obligations,
    tasks,
    getDefinitionForTask,
    now,
    supervisorRuns,
    evidence,
    clearContextHashes,
  }: Pick<
    ReturnType<typeof createKernelState>,
    | 'obligations'
    | 'tasks'
    | 'getDefinitionForTask'
    | 'now'
    | 'supervisorRuns'
    | 'evidence'
    | 'clearContextHashes'
  >,
  {
    withIdempotency,
    appendEvent,
  }: Pick<ReturnType<typeof createJournal>, 'withIdempotency' | 'appendEvent'>
) {
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

  // Callers retain their distinct authorization and reference-validation rules.
  const recordWaiver = (
    resolved: {
      task: WorkflowTask
      list: ObligationRecord[]
      index: number
      obligation: ObligationRecord
    },
    request: {
      actor: ActorRef
      supervisorRunId?: string | undefined
      reason: string
      evidenceRefs?: string[] | undefined
    },
    idempotencyKey: string
  ): WorkflowResult<{ task: WorkflowTask; obligation: ObligationRecord }> => {
    const { task, list, index, obligation } = resolved
    const obligationId = obligation.obligationId
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
  }

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
      const { task, obligation } = resolved
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
      return recordWaiver(resolved, request, idempotencyKey)
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

  return {
    resolveObligation,
    recordWaiver,
    nextTaskAfterObligationClosed,
    waiveObligation,
    cancelObligation,
    expireObligation,
  }
}
