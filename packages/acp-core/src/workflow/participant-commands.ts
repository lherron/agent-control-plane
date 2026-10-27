import type { createContexts } from './contexts.js'
import { actorEquals, reject } from './domain-policy.js'
import type { createJournal } from './journal.js'
import type { createKernelState } from './kernel-state.js'
import type { ActorRef, ParticipantRunRecord, WorkflowHrcRunMap, WorkflowResult } from './types.js'
import { clone } from './value-semantics.js'

export function createParticipantCommands(
  {
    withIdempotency,
    rejectAndRecord,
    appendEvent,
  }: Pick<ReturnType<typeof createJournal>, 'withIdempotency' | 'rejectAndRecord' | 'appendEvent'>,
  {
    tasks,
    getDefinitionForTask,
    nextId,
    now,
    participantRuns,
    workflowHrcRunMaps,
  }: Pick<
    ReturnType<typeof createKernelState>,
    'tasks' | 'getDefinitionForTask' | 'nextId' | 'now' | 'participantRuns' | 'workflowHrcRunMaps'
  >,
  {
    buildParticipantRunContext,
  }: Pick<ReturnType<typeof createContexts>, 'buildParticipantRunContext'>
) {
  const startParticipantRun = (request: {
    taskId: string
    role: string
    actor: ActorRef
    harness?: Record<string, unknown> | undefined
    parentSupervisorRunId?: string | undefined
    hrc?:
      | Omit<WorkflowHrcRunMap, 'mapId' | 'workflowTaskId' | 'participantRunId' | 'createdAt'>
      | undefined
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
        const error = reject(
          'role_not_bound',
          `Role "${request.role}" is not defined by workflow "${definition.id}"`
        ).error
        return rejectAndRecord(task, {
          type: 'participant_run.rejected',
          actor: request.actor,
          role: request.role,
          idempotencyKey,
          error,
          command: request,
        })
      }
      const boundActor = task.roleBindings[request.role]
      if (boundActor === undefined || boundActor === null) {
        const error = reject(
          'role_not_bound',
          `Role "${request.role}" is not bound — cannot launch participant run`
        ).error
        return rejectAndRecord(task, {
          type: 'participant_run.rejected',
          actor: request.actor,
          role: request.role,
          idempotencyKey,
          error,
          command: request,
        })
      }
      if (!actorEquals(boundActor, request.actor)) {
        const error = reject(
          'role_not_bound',
          `Role "${request.role}" is bound to a different actor`
        ).error
        return rejectAndRecord(task, {
          type: 'participant_run.rejected',
          actor: request.actor,
          role: request.role,
          idempotencyKey,
          error,
          command: request,
        })
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
      const launchEvent = appendEvent(task, {
        taskId: task.taskId,
        type: 'participant_run.launched',
        commandType: 'participant.run.admitted',
        actor: request.actor,
        participantRunId: runId,
        observedTaskVersion: task.version,
        idempotencyKey,
        payload: { runId, role: run.role, actor: clone(request.actor) },
      })
      if (request.hrc !== undefined) {
        const map: WorkflowHrcRunMap = {
          mapId: nextId('whrc'),
          workflowTaskId: task.taskId,
          participantRunId: runId,
          ...clone(request.hrc),
          createdAt: now,
        }
        workflowHrcRunMaps.set(task.taskId, [
          ...(workflowHrcRunMaps.get(task.taskId) ?? []),
          clone(map),
        ])
        appendEvent(task, {
          taskId: task.taskId,
          type: 'workflow_hrc_run.mapped',
          commandType: 'workflow.hrc_run.mapped',
          causationId: launchEvent.eventId,
          actor: request.actor,
          participantRunId: runId,
          observedTaskVersion: task.version,
          idempotencyKey,
          result: 'recorded',
          payload: clone(map) as unknown as Record<string, unknown>,
        })
      }
      return { ok: true, participantRun: clone(run), context: clone(context) }
    })

  const recordWorkflowHrcRunMap = (request: {
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
    source: WorkflowHrcRunMap['source']
    actor?: ActorRef | undefined
    idempotencyKey?: string | undefined
  }): WorkflowResult<{ map: WorkflowHrcRunMap }> =>
    withIdempotency(request.idempotencyKey, request, () => {
      const idempotencyKey = request.idempotencyKey ?? ''
      const task = tasks.get(request.workflowTaskId)
      if (task === undefined) {
        return reject('task_not_found', `Task not found: ${request.workflowTaskId}`)
      }
      const map: WorkflowHrcRunMap = {
        mapId: nextId('whrc'),
        workflowTaskId: task.taskId,
        ...(request.participantRunId !== undefined
          ? { participantRunId: request.participantRunId }
          : {}),
        ...(request.supervisorRunId !== undefined
          ? { supervisorRunId: request.supervisorRunId }
          : {}),
        hrcRunId: request.hrcRunId,
        ...(request.runtimeId !== undefined ? { runtimeId: request.runtimeId } : {}),
        ...(request.launchId !== undefined ? { launchId: request.launchId } : {}),
        ...(request.hostSessionId !== undefined ? { hostSessionId: request.hostSessionId } : {}),
        ...(request.scopeRef !== undefined ? { scopeRef: request.scopeRef } : {}),
        ...(request.laneRef !== undefined ? { laneRef: request.laneRef } : {}),
        ...(request.generation !== undefined ? { generation: request.generation } : {}),
        createdAt: now,
        source: request.source,
      }
      workflowHrcRunMaps.set(task.taskId, [
        ...(workflowHrcRunMaps.get(task.taskId) ?? []),
        clone(map),
      ])
      appendEvent(task, {
        taskId: task.taskId,
        type: 'workflow_hrc_run.mapped',
        commandType: 'workflow.hrc_run.mapped',
        actor: request.actor ?? { kind: 'service', id: 'workflow-kernel' },
        ...(request.participantRunId !== undefined
          ? { participantRunId: request.participantRunId }
          : {}),
        ...(request.supervisorRunId !== undefined
          ? { supervisorRunId: request.supervisorRunId }
          : {}),
        observedTaskVersion: task.version,
        idempotencyKey,
        result: 'recorded',
        payload: clone(map) as unknown as Record<string, unknown>,
      })
      return { ok: true, map: clone(map) }
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

  const finishParticipantRun = (
    runId: string,
    idempotencyKey: string,
    update: Partial<ParticipantRunRecord>,
    type: 'participant_run.completed' | 'participant_run.cancelled',
    payload: Record<string, unknown>
  ): WorkflowResult<{ participantRun: ParticipantRunRecord }> => {
    for (const [taskId, runs] of participantRuns.entries()) {
      const idx = runs.findIndex((run) => run.runId === runId)
      if (idx < 0) continue
      const run = runs[idx]
      if (run === undefined) continue
      const task = tasks.get(taskId)
      if (task === undefined) continue
      const updated: ParticipantRunRecord = { ...run, ...update, completedAt: now }
      const nextRuns = [...runs]
      nextRuns[idx] = clone(updated)
      participantRuns.set(taskId, nextRuns)
      appendEvent(task, {
        taskId,
        type,
        actor: run.actor,
        participantRunId: runId,
        observedTaskVersion: task.version,
        idempotencyKey,
        payload,
      })
      return { ok: true, participantRun: clone(updated) }
    }
    return reject('task_not_found', `Participant run not found: ${runId}`)
  }

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
      return finishParticipantRun(
        runId,
        request.idempotencyKey ?? '',
        {
          status: 'completed',
          outcome: request.outcome,
          ...(request.summary !== undefined ? { summary: request.summary } : {}),
        },
        'participant_run.completed',
        {
          outcome: request.outcome,
          ...(request.evidenceRefs !== undefined ? { evidenceRefs: request.evidenceRefs } : {}),
          ...(request.summary !== undefined ? { summary: request.summary } : {}),
        }
      )
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
      return finishParticipantRun(
        runId,
        request.idempotencyKey ?? '',
        {
          status: 'failed',
          outcome: 'failed',
          failureReason: request.reason,
          ...(request.classification !== undefined
            ? { failureClassification: request.classification }
            : {}),
        },
        'participant_run.completed',
        {
          outcome: 'failed',
          reason: request.reason,
          ...(request.classification !== undefined
            ? { classification: request.classification }
            : {}),
        }
      )
    })

  const cancelParticipantRun = (
    runId: string,
    request: {
      reason: string
      idempotencyKey?: string | undefined
    }
  ): WorkflowResult<{ participantRun: ParticipantRunRecord }> =>
    withIdempotency(request.idempotencyKey, { runId, ...request }, () => {
      return finishParticipantRun(
        runId,
        request.idempotencyKey ?? '',
        { status: 'cancelled', cancelReason: request.reason },
        'participant_run.cancelled',
        {
          reason: request.reason,
        }
      )
    })

  return {
    startParticipantRun,
    recordWorkflowHrcRunMap,
    resumeParticipantRun,
    markParticipantRunRunning,
    completeParticipantRun,
    failParticipantRun,
    cancelParticipantRun,
  }
}
