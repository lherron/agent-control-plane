import type {
  EffectIntent,
  EvidenceRecord,
  ObligationRecord,
  ParticipantRunRecord,
  PublishedWorkflowDefinition,
  SupervisorRunRecord,
  WorkflowAnomaly,
  WorkflowEvent,
  WorkflowHrcRunMap,
  WorkflowIdempotencyRecord,
  WorkflowPatchProposal,
  WorkflowTask,
} from './types.js'
import type { WorkflowKernelSnapshot } from './types.js'
import { clone, deepFreeze } from './value-semantics.js'

export function createKernelState(input: {
  now?: string | undefined
  snapshot?: WorkflowKernelSnapshot | undefined
}) {
  const now = input.now ?? new Date().toISOString()

  const definitions = new Map<string, PublishedWorkflowDefinition>()

  const tasks = new Map<string, WorkflowTask>()

  const evidence = new Map<string, EvidenceRecord[]>()

  const obligations = new Map<string, ObligationRecord[]>()

  const effects = new Map<string, EffectIntent[]>()

  const events = new Map<string, WorkflowEvent[]>()

  const workflowHrcRunMaps = new Map<string, WorkflowHrcRunMap[]>()

  const supervisorRuns = new Map<string, SupervisorRunRecord[]>()

  const participantRuns = new Map<string, ParticipantRunRecord[]>()

  const anomalies = new Map<string, WorkflowAnomaly[]>()

  const patchProposals = new Map<string, WorkflowPatchProposal[]>()

  const idempotency = new Map<string, WorkflowIdempotencyRecord>()

  const currentContextHashes = new Map<string, Set<string>>()

  let sequence = 0

  const nextId = (prefix: string): string => `${prefix}_${String(++sequence).padStart(4, '0')}`

  const definitionKey = (id: string, version: number): string => `${id}@${version}`

  if (input.snapshot !== undefined) {
    for (const definition of input.snapshot.definitions) {
      definitions.set(
        definitionKey(definition.id, definition.version),
        deepFreeze(clone(definition))
      )
    }
    for (const task of input.snapshot.tasks) {
      tasks.set(task.taskId, clone(task))
    }
    const restoreGroup = <T>(
      map: Map<string, T[]>,
      records: readonly T[],
      key: (record: T) => string
    ): void => {
      for (const record of records) {
        const id = key(record)
        map.set(id, [...(map.get(id) ?? []), clone(record)])
      }
    }
    restoreGroup(evidence, input.snapshot.evidence, (record) => record.taskId)
    restoreGroup(obligations, input.snapshot.obligations, (record) => record.taskId)
    restoreGroup(effects, input.snapshot.effects, (record) => record.taskId)
    restoreGroup(events, input.snapshot.events, (record) => record.taskId)
    restoreGroup(
      workflowHrcRunMaps,
      input.snapshot.workflowHrcRunMaps ?? [],
      (record) => record.workflowTaskId
    )
    restoreGroup(supervisorRuns, input.snapshot.supervisorRuns, (record) => record.taskId)
    restoreGroup(participantRuns, input.snapshot.participantRuns, (record) => record.taskId)
    restoreGroup(anomalies, input.snapshot.anomalies, (record) => record.taskId)
    restoreGroup(patchProposals, input.snapshot.patchProposals, (record) => record.taskId)
    for (const entry of input.snapshot.idempotency) {
      idempotency.set(entry.key, clone(entry.record))
    }
    for (const entry of input.snapshot.contextHashes) {
      currentContextHashes.set(entry.taskId, new Set(entry.hashes))
    }
    sequence = input.snapshot.sequence
  }

  const rememberContextHash = (taskId: string, hash: string): void => {
    currentContextHashes.set(taskId, new Set([...(currentContextHashes.get(taskId) ?? []), hash]))
  }

  const clearContextHashes = (taskId: string): void => {
    currentContextHashes.delete(taskId)
  }

  const getDefinitionForTask = (task: WorkflowTask): PublishedWorkflowDefinition => {
    const definition = definitions.get(definitionKey(task.workflow.id, task.workflow.version))
    if (definition === undefined) {
      throw new Error(
        `Workflow definition missing for ${task.workflow.id}@${task.workflow.version}`
      )
    }
    return definition
  }

  const getSequence = () => sequence

  return {
    idempotency,
    events,
    nextId,
    now,
    effects,
    obligations,
    getDefinitionForTask,
    definitions,
    definitionKey,
    tasks,
    evidence,
    supervisorRuns,
    participantRuns,
    anomalies,
    patchProposals,
    rememberContextHash,
    clearContextHashes,
    workflowHrcRunMaps,
    currentContextHashes,
    getSequence,
  }
}
