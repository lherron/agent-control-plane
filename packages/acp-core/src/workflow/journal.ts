import { hashValue } from '../internal/canonical-json.js'
import { reject } from './domain-policy.js'
import type { createKernelState } from './kernel-state.js'
import type {
  ActorRef,
  EffectIntent,
  WorkflowEvent,
  WorkflowRejection,
  WorkflowTask,
} from './types.js'
import { clone } from './value-semantics.js'

export function createJournal({
  idempotency,
  events,
  nextId,
  now,
  getSequence,
  effects,
}: Pick<
  ReturnType<typeof createKernelState>,
  'idempotency' | 'events' | 'nextId' | 'now' | 'getSequence' | 'effects'
>) {
  const withIdempotency = <T extends { ok: boolean }>(
    idempotencyKey: string | undefined,
    payload: unknown,
    mutator: () => T
  ): T | { ok: false; error: WorkflowRejection } => {
    if (!idempotencyKey) {
      return reject(
        'idempotency_key_required',
        'Mutating workflow commands require an idempotency key'
      )
    }
    const fingerprint = hashValue(payload)
    const existing = idempotency.get(idempotencyKey)
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        return reject(
          'idempotency_conflict',
          `Idempotency key "${idempotencyKey}" was used with a different payload`
        )
      }
      return clone(existing.result) as T
    }
    const result = mutator()
    idempotency.set(idempotencyKey, { fingerprint, result: clone(result) })
    return result
  }

  const appendEvent = (
    task: WorkflowTask,
    inputEvent: Omit<
      WorkflowEvent,
      | 'eventId'
      | 'workflowSeq'
      | 'schemaVersion'
      | 'createdAt'
      | 'workflow'
      | 'result'
      | 'eventHash'
      | 'prevHash'
    > & { result?: WorkflowEvent['result'] | undefined }
  ): WorkflowEvent => {
    const existingEvents = events.get(task.taskId) ?? []
    const eventWithoutHash: Omit<WorkflowEvent, 'eventHash'> = {
      eventId: nextId('wevt'),
      workflowSeq: existingEvents.length + 1,
      schemaVersion: 1,
      createdAt: now,
      workflow: task.workflow,
      ...inputEvent,
      result: inputEvent.result ?? 'accepted',
      commandType: inputEvent.commandType ?? inputEvent.type,
      commandHash:
        inputEvent.commandHash ??
        hashValue({
          type: inputEvent.commandType ?? inputEvent.type,
          idempotencyKey: inputEvent.idempotencyKey,
          payload: inputEvent.payload,
        }),
      ...(existingEvents.at(-1)?.eventHash !== undefined
        ? { prevHash: existingEvents.at(-1)?.eventHash }
        : {}),
    }
    const event: WorkflowEvent = {
      ...eventWithoutHash,
      eventHash: hashValue(eventWithoutHash),
    }
    events.set(task.taskId, [...existingEvents, clone(event)])
    return event
  }

  const redactedCommand = (value: unknown): Record<string, unknown> => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return {}
    }
    const record = value as Record<string, unknown>
    return Object.fromEntries(
      Object.entries(record).filter(
        ([key]) => !['inlineEvidence', 'evidence', 'data', 'payload'].includes(key)
      )
    )
  }

  const recordRejectedCommand = (
    task: WorkflowTask,
    input: {
      type: string
      actor: ActorRef
      idempotencyKey: string
      error: WorkflowRejection
      command: Record<string, unknown>
      contextHash?: string | undefined
      role?: string | undefined
      authority?: string | undefined
      runId?: string | undefined
      supervisorRunId?: string | undefined
      participantRunId?: string | undefined
    }
  ): void => {
    appendEvent(task, {
      taskId: task.taskId,
      type: input.type,
      commandType: input.type,
      actor: input.actor,
      ...(input.role !== undefined ? { role: input.role } : {}),
      ...(input.authority !== undefined ? { authority: input.authority } : {}),
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
      ...(input.supervisorRunId !== undefined ? { supervisorRunId: input.supervisorRunId } : {}),
      ...(input.participantRunId !== undefined ? { participantRunId: input.participantRunId } : {}),
      observedTaskVersion: task.version,
      ...(input.contextHash !== undefined ? { contextHash: input.contextHash } : {}),
      idempotencyKey: input.idempotencyKey,
      result: 'rejected',
      rejectionCode: input.error.code,
      payload: {
        rejection: clone(input.error),
        command: redactedCommand(input.command),
      },
    })
  }

  const rejectAndRecord = (
    task: WorkflowTask,
    input: {
      type: string
      actor: ActorRef
      idempotencyKey: string
      error: WorkflowRejection
      command: Record<string, unknown>
      contextHash?: string | undefined
      role?: string | undefined
      authority?: string | undefined
      runId?: string | undefined
      supervisorRunId?: string | undefined
      participantRunId?: string | undefined
    }
  ): { ok: false; error: WorkflowRejection } => {
    recordRejectedCommand(task, input)
    return { ok: false, error: input.error }
  }

  const createEffectIntent = (
    task: WorkflowTask,
    sourceEventId: string,
    idempotencyKey: string,
    kind: string,
    payload: Record<string, unknown>,
    actor: ActorRef,
    observedTaskVersion: number
  ): EffectIntent => {
    const effect: EffectIntent = {
      effectId: nextId('eff'),
      taskId: task.taskId,
      sourceEventId,
      kind,
      payload: clone(payload),
      idempotencyKey: `${idempotencyKey}:effect:${kind}:${getSequence()}`,
      state: 'pending',
      createdAt: now,
      updatedAt: now,
    }
    effects.set(task.taskId, [...(effects.get(task.taskId) ?? []), clone(effect)])
    appendEvent(task, {
      taskId: task.taskId,
      type: 'effect_intent.created',
      actor,
      observedTaskVersion,
      idempotencyKey,
      payload: { effectId: effect.effectId, kind, payload },
    })
    return effect
  }

  return { createEffectIntent, withIdempotency, appendEvent, rejectAndRecord }
}
