import { actorEquals, reject } from './domain-policy.js'
import type { createJournal } from './journal.js'
import type { createKernelState } from './kernel-state.js'
import type {
  ActorRef,
  EvidenceInput,
  EvidenceRecord,
  WorkflowRejection,
  WorkflowRejectionCode,
  WorkflowResult,
  WorkflowTask,
} from './types.js'
import { clone } from './value-semantics.js'

export function createEvidenceCommands(
  {
    nextId,
    now,
    evidence,
    participantRuns,
    supervisorRuns,
    tasks,
    getDefinitionForTask,
  }: Pick<
    ReturnType<typeof createKernelState>,
    | 'nextId'
    | 'now'
    | 'evidence'
    | 'participantRuns'
    | 'supervisorRuns'
    | 'tasks'
    | 'getDefinitionForTask'
  >,
  {
    appendEvent,
    withIdempotency,
  }: Pick<ReturnType<typeof createJournal>, 'appendEvent' | 'withIdempotency'>
) {
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

  return { addEvidence, attachEvidence }
}
