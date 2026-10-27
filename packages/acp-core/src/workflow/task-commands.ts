import { hashValue } from '../internal/canonical-json.js'
import { applyStatePatch, reject, validateWorkState } from './domain-policy.js'
import type { createJournal } from './journal.js'
import type { createKernelState } from './kernel-state.js'
import type {
  PublishedWorkflowDefinition,
  RoleBindings,
  SupervisorBinding,
  WorkflowDefinition,
  WorkflowResult,
  WorkflowTask,
} from './types.js'
import { clone, deepFreeze } from './value-semantics.js'

export function createTaskCommands(
  {
    definitions,
    definitionKey,
    now,
    tasks,
    evidence,
    obligations,
    effects,
    events,
    supervisorRuns,
    participantRuns,
    anomalies,
    patchProposals,
  }: Pick<
    ReturnType<typeof createKernelState>,
    | 'definitions'
    | 'definitionKey'
    | 'now'
    | 'tasks'
    | 'evidence'
    | 'obligations'
    | 'effects'
    | 'events'
    | 'supervisorRuns'
    | 'participantRuns'
    | 'anomalies'
    | 'patchProposals'
  >,
  {
    withIdempotency,
    appendEvent,
  }: Pick<ReturnType<typeof createJournal>, 'withIdempotency' | 'appendEvent'>
) {
  const publishWorkflowDefinition = (
    definition: WorkflowDefinition
  ): PublishedWorkflowDefinition => {
    const validation = validateWorkState(definition.initial)
    if (validation !== undefined) {
      throw new Error(validation.message)
    }
    for (const transition of Object.values(definition.transitions)) {
      const toValidation = validateWorkState(applyStatePatch(definition.initial, transition.to))
      if (toValidation !== undefined) {
        throw new Error(toValidation.message)
      }
    }
    const definitionForHash = clone(definition)
    definitionForHash.hash = undefined
    const hash = definition.hash ?? hashValue(definitionForHash)
    const published = deepFreeze({
      ...clone(definition),
      hash,
      workflow: { id: definition.id, version: definition.version, hash },
    })
    definitions.set(definitionKey(definition.id, definition.version), published)
    return published
  }

  const getWorkflowDefinition = (
    id: string,
    version: number
  ): PublishedWorkflowDefinition | undefined => definitions.get(definitionKey(id, version))

  const resolveWorkflowForCreate = (
    workflow: { id: string; version: number } | { definition: WorkflowDefinition } | undefined
  ): WorkflowResult<{ definition: PublishedWorkflowDefinition }> => {
    if (workflow === undefined) {
      return reject('workflow_required', 'Durable workflow tasks require a workflow definition')
    }
    if ('definition' in workflow) {
      const validation = validateWorkState(workflow.definition.initial)
      if (validation !== undefined) {
        return { ok: false, error: validation }
      }
      return { ok: true, definition: publishWorkflowDefinition(workflow.definition) }
    }
    const definition = getWorkflowDefinition(workflow.id, workflow.version)
    if (definition === undefined) {
      return reject(
        'workflow_not_found',
        `Workflow "${workflow.id}@${workflow.version}" is not published`
      )
    }
    return { ok: true, definition }
  }

  const createTask = (request: {
    taskId: string
    projectId: string
    workflow?: { id: string; version: number } | { definition: WorkflowDefinition } | undefined
    goal: string
    risk?: string | undefined
    initialFacts?: Record<string, unknown> | undefined
    roleBindings?: RoleBindings | undefined
    supervisor?: SupervisorBinding | undefined
    idempotencyKey?: string | undefined
  }): WorkflowResult<{ task: WorkflowTask }> =>
    withIdempotency(request.idempotencyKey, request, () => {
      const idempotencyKey = request.idempotencyKey ?? ''
      const resolved = resolveWorkflowForCreate(request.workflow)
      if (!resolved.ok) {
        return resolved
      }
      const task: WorkflowTask = {
        taskId: request.taskId,
        projectId: request.projectId,
        workflow: resolved.definition.workflow,
        state: clone(resolved.definition.initial),
        version: 0,
        goal: request.goal,
        ...(request.risk ? { risk: request.risk } : {}),
        ...(request.initialFacts ? { facts: clone(request.initialFacts) } : {}),
        roleBindings: clone(request.roleBindings ?? {}),
        ...(request.supervisor ? { supervisor: clone(request.supervisor) } : {}),
        createdAt: now,
        updatedAt: now,
      }
      tasks.set(task.taskId, clone(task))
      evidence.set(task.taskId, [])
      obligations.set(task.taskId, [])
      effects.set(task.taskId, [])
      events.set(task.taskId, [])
      supervisorRuns.set(task.taskId, [])
      participantRuns.set(task.taskId, [])
      anomalies.set(task.taskId, [])
      patchProposals.set(task.taskId, [])
      appendEvent(task, {
        taskId: task.taskId,
        type: 'task.created',
        actor: request.supervisor?.actor ?? { kind: 'service', id: 'workflow-kernel' },
        observedTaskVersion: 0,
        nextTaskVersion: 0,
        idempotencyKey,
        payload: {
          goal: task.goal,
          state: task.state,
          roleBindings: task.roleBindings,
        },
      })
      return { ok: true, task: clone(task) }
    })

  return { publishWorkflowDefinition, getWorkflowDefinition, createTask }
}
