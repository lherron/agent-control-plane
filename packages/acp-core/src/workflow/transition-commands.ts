import { applyStatePatch, reject, validateWorkState } from './domain-policy.js'
import type { createEvidenceCommands } from './evidence-commands.js'
import type { createJournal } from './journal.js'
import type { createKernelState } from './kernel-state.js'
import type { createTransitionPolicy } from './transition-policy.js'
import type {
  ActorRef,
  EffectIntent,
  EvidenceInput,
  WorkflowEvent,
  WorkflowRejection,
  WorkflowResult,
  WorkflowTask,
} from './types.js'
import { clone } from './value-semantics.js'

export function createTransitionCommands(
  {
    withIdempotency,
    rejectAndRecord,
    appendEvent,
  }: Pick<ReturnType<typeof createJournal>, 'withIdempotency' | 'rejectAndRecord' | 'appendEvent'>,
  {
    tasks,
    currentContextHashes,
    getDefinitionForTask,
    evidence,
    now,
    clearContextHashes,
    effects,
  }: Pick<
    ReturnType<typeof createKernelState>,
    | 'tasks'
    | 'currentContextHashes'
    | 'getDefinitionForTask'
    | 'evidence'
    | 'now'
    | 'clearContextHashes'
    | 'effects'
  >,
  {
    evaluateTransition,
    materializeTransitionEffect,
  }: Pick<
    ReturnType<typeof createTransitionPolicy>,
    'evaluateTransition' | 'materializeTransitionEffect'
  >,
  { addEvidence }: Pick<ReturnType<typeof createEvidenceCommands>, 'addEvidence'>
) {
  const applyTransition = (request: {
    taskId: string
    transitionId: string
    actor: ActorRef
    role: string
    expectedTaskVersion: number
    contextHash?: string | undefined
    evidenceRefs?: string[] | undefined
    inlineEvidence?: EvidenceInput[] | undefined
    waiverRefs?: string[] | undefined
    runId?: string | undefined
    idempotencyKey?: string | undefined
  }): WorkflowResult<{ task: WorkflowTask; event: WorkflowEvent; effects: EffectIntent[] }> =>
    withIdempotency(request.idempotencyKey, request, () => {
      const idempotencyKey = request.idempotencyKey ?? ''
      const task = tasks.get(request.taskId)
      if (task === undefined) {
        return reject('task_not_found', `Task not found: ${request.taskId}`)
      }
      const rejectTransition = (error: WorkflowRejection) =>
        rejectAndRecord(task, {
          type: 'transition.rejected',
          actor: request.actor,
          role: request.role,
          idempotencyKey,
          error,
          command: request,
          ...(request.contextHash !== undefined ? { contextHash: request.contextHash } : {}),
          ...(request.runId !== undefined ? { runId: request.runId } : {}),
        })
      if (request.expectedTaskVersion !== task.version) {
        const error = reject(
          'version_conflict',
          `Task version ${task.version} does not match expected version ${request.expectedTaskVersion}`
        ).error
        return rejectTransition(error)
      }
      if (
        request.contextHash !== undefined &&
        currentContextHashes.get(task.taskId)?.has(request.contextHash) !== true
      ) {
        const error = reject(
          'context_stale',
          'The supplied context hash is not current for this task'
        ).error
        return rejectTransition(error)
      }
      const definition = getDefinitionForTask(task)
      const transition = definition.transitions[request.transitionId]
      if (transition === undefined) {
        const error = reject('unknown_transition', `Unknown transition "${request.transitionId}"`, {
          transitionId: request.transitionId,
        }).error
        return rejectTransition(error)
      }
      const combinedEvidence = [
        ...(evidence.get(task.taskId) ?? []),
        ...(request.inlineEvidence ?? []),
      ]
      const transitionError = evaluateTransition(
        task,
        transition,
        request.actor,
        request.role,
        combinedEvidence,
        request.waiverRefs
      )
      if (transitionError !== undefined) {
        return rejectTransition(transitionError)
      }
      const roleSpec = definition.roles[request.role]
      if (
        (task.roleBindings[request.role] === undefined ||
          task.roleBindings[request.role] === null) &&
        roleSpec?.binding === 'autoBindOnFirstRun'
      ) {
        task.roleBindings[request.role] = clone(request.actor)
      }
      if ((request.inlineEvidence ?? []).length > 0) {
        addEvidence(
          task,
          request.inlineEvidence ?? [],
          request.actor,
          idempotencyKey,
          task.version,
          {
            role: request.role,
            runId: request.runId,
          }
        )
      }
      const previousVersion = task.version
      const nextTask: WorkflowTask = {
        ...task,
        state: applyStatePatch(task.state, transition.to),
        version: task.version + 1,
        updatedAt: now,
      }
      const validation = validateWorkState(nextTask.state)
      if (validation !== undefined) {
        return rejectTransition(validation)
      }
      tasks.set(task.taskId, clone(nextTask))
      clearContextHashes(task.taskId)
      const event = appendEvent(nextTask, {
        taskId: task.taskId,
        type: 'transition.applied',
        commandType: 'transition.accepted',
        actor: request.actor,
        role: request.role,
        ...(request.runId ? { runId: request.runId } : {}),
        observedTaskVersion: previousVersion,
        nextTaskVersion: nextTask.version,
        ...(request.contextHash ? { contextHash: request.contextHash } : {}),
        idempotencyKey,
        payload: {
          transitionId: request.transitionId,
          role: request.role,
          from: task.state,
          to: nextTask.state,
          evidenceKinds: (request.inlineEvidence ?? []).map((item) => item.kind),
          ...(request.evidenceRefs !== undefined ? { evidenceRefs: request.evidenceRefs } : {}),
          ...(request.waiverRefs !== undefined ? { waiverRefs: request.waiverRefs } : {}),
        },
      })
      const beforeEffectCount = effects.get(task.taskId)?.length ?? 0
      for (const effect of transition.effects ?? []) {
        materializeTransitionEffect(nextTask, event, effect, request.actor, idempotencyKey)
      }
      return {
        ok: true,
        task: clone(nextTask),
        event: clone(event),
        effects: clone((effects.get(task.taskId) ?? []).slice(beforeEffectCount)),
      }
    })

  return { applyTransition }
}
