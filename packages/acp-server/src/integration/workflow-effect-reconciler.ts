import type { ActorRef, EffectIntent, WorkflowEvent, WorkflowTask } from 'acp-core'
import type { AcpStateStore } from 'acp-state-store'
import { normalizeSessionRef } from 'agent-scope'
import {
  type AppendEventResult,
  type CoordinationStore,
  type HandoffKind,
  type ParticipantRef,
  appendEvent,
} from 'coordination-substrate'

const DEFAULT_DRAIN_LIMIT = 100
const HANDOFF_KINDS = new Set([
  'review',
  'approval',
  'delivery',
  'tool-wait',
  'human-wait',
  'blocked',
])

export type WorkflowEffectReconcileResult = {
  scanned: number
  delivered: Array<{ effectId: string; result?: AppendEventResult | undefined }>
}

function actorToParticipant(actor: ActorRef): ParticipantRef {
  if (actor.kind === 'agent') {
    return { kind: 'agent', agentId: actor.id }
  }
  if (actor.kind === 'human') {
    return { kind: 'human', id: actor.id }
  }
  return { kind: 'system', id: actor.id }
}

function asHandoffKind(value: unknown): HandoffKind {
  return typeof value === 'string' && HANDOFF_KINDS.has(value) ? (value as HandoffKind) : 'review'
}

function requireRoleBinding(task: WorkflowTask, role: string): ActorRef {
  const actor = task.roleBindings[role]
  if (actor === undefined || actor === null) {
    throw new Error(`workflow effect target role is not bound: ${role}`)
  }
  return actor
}

function actorFromEffectPayload(value: unknown): ActorRef | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined
  }
  const record = value as Record<string, unknown>
  if (
    (record['kind'] === 'agent' ||
      record['kind'] === 'human' ||
      record['kind'] === 'service' ||
      record['kind'] === 'group') &&
    typeof record['id'] === 'string'
  ) {
    return { kind: record['kind'], id: record['id'] } as ActorRef
  }
  return undefined
}

function resolveEffectTargetActor(input: {
  task: WorkflowTask
  role: string
  effect: EffectIntent
}): ActorRef {
  return (
    input.task.roleBindings[input.role] ??
    actorFromEffectPayload(input.effect.payload['actor']) ??
    requireRoleBinding(input.task, input.role)
  )
}

function roleSessionRef(input: { task: WorkflowTask; role: string; actor: ActorRef }) {
  if (input.actor.kind !== 'agent') {
    throw new Error(`workflow wake target role must be bound to an agent: ${input.role}`)
  }

  return normalizeSessionRef({
    scopeRef: `agent:${input.actor.id}:project:${input.task.projectId}:task:${input.task.taskId}:role:${input.role}`,
    laneRef: 'main',
  })
}

function buildDeclareHandoffCommand(input: {
  task: WorkflowTask
  sourceEvent: WorkflowEvent
  effect: EffectIntent
}) {
  const toRole = String(input.effect.payload['toRole'] ?? '')
  if (toRole.length === 0) {
    throw new Error(`workflow handoff effect missing toRole: ${input.effect.effectId}`)
  }

  const targetActor = requireRoleBinding(input.task, toRole)
  const targetParticipant = actorToParticipant(targetActor)
  const sessionRef =
    targetActor.kind === 'agent'
      ? roleSessionRef({ task: input.task, role: toRole, actor: targetActor })
      : undefined
  const actor = actorToParticipant(input.sourceEvent.actor)
  const reason =
    typeof input.effect.payload['reason'] === 'string'
      ? input.effect.payload['reason']
      : `Workflow task ${input.task.taskId} is ready for ${toRole}`

  return {
    projectId: input.task.projectId,
    idempotencyKey: input.effect.idempotencyKey,
    event: {
      ts: new Date().toISOString(),
      kind: 'handoff.declared' as const,
      actor,
      ...(sessionRef !== undefined ? { semanticSession: sessionRef } : {}),
      participants: [actor, targetParticipant],
      content: { kind: 'text' as const, body: reason },
      links: {
        taskId: input.task.taskId,
        ...(input.sourceEvent.runId !== undefined ? { runId: input.sourceEvent.runId } : {}),
      },
      meta: {
        workflowEffectId: input.effect.effectId,
        workflowEffectKind: input.effect.kind,
        sourceWorkflowEventId: input.effect.sourceEventId,
        toRole,
      },
    },
    handoff: {
      taskId: input.task.taskId,
      from: actor,
      to:
        sessionRef !== undefined
          ? ({ kind: 'session' as const, sessionRef } satisfies ParticipantRef)
          : targetParticipant,
      ...(sessionRef !== undefined ? { targetSession: sessionRef } : {}),
      kind: asHandoffKind(input.effect.payload['kind']),
      reason,
    },
  }
}

function buildWakeRoleSessionCommand(input: {
  task: WorkflowTask
  sourceEvent: WorkflowEvent
  effect: EffectIntent
}) {
  const role = String(input.effect.payload['role'] ?? '')
  if (role.length === 0) {
    throw new Error(`workflow wake effect missing role: ${input.effect.effectId}`)
  }

  const targetActor = resolveEffectTargetActor({ task: input.task, role, effect: input.effect })
  const sessionRef = roleSessionRef({ task: input.task, role, actor: targetActor })
  const actor = actorToParticipant(input.sourceEvent.actor)
  const reason =
    typeof input.effect.payload['reason'] === 'string'
      ? input.effect.payload['reason']
      : `Workflow task ${input.task.taskId} requested ${role}`

  return {
    projectId: input.task.projectId,
    idempotencyKey: input.effect.idempotencyKey,
    event: {
      ts: new Date().toISOString(),
      kind: 'attention.requested' as const,
      actor,
      semanticSession: sessionRef,
      participants: [actor, { kind: 'session' as const, sessionRef }],
      content: { kind: 'text' as const, body: reason },
      links: {
        taskId: input.task.taskId,
        ...(input.sourceEvent.runId !== undefined ? { runId: input.sourceEvent.runId } : {}),
      },
      meta: {
        workflowEffectId: input.effect.effectId,
        workflowEffectKind: input.effect.kind,
        sourceWorkflowEventId: input.effect.sourceEventId,
        role,
      },
    },
    wake: {
      sessionRef,
      reason,
      dedupeKey: input.effect.idempotencyKey,
    },
  }
}

function deliverEffect(input: {
  coordStore: CoordinationStore
  task: WorkflowTask
  sourceEvent: WorkflowEvent
  effect: EffectIntent
}): AppendEventResult | undefined {
  if (input.effect.kind === 'declare_handoff') {
    return appendEvent(input.coordStore, buildDeclareHandoffCommand(input))
  }
  if (input.effect.kind === 'wake_role_session') {
    return appendEvent(input.coordStore, buildWakeRoleSessionCommand(input))
  }
  return undefined
}

export async function reconcileWorkflowEffectIntents(input: {
  stateStore: AcpStateStore
  coordStore: CoordinationStore
  limit?: number | undefined
}): Promise<WorkflowEffectReconcileResult> {
  const pending = input.stateStore.workflowRuntime.listPendingEffectIntents(
    input.limit ?? DEFAULT_DRAIN_LIMIT
  )
  const snapshot = input.stateStore.workflowRuntime.loadSnapshot()
  const tasks = new Map(snapshot.tasks.map((task) => [task.taskId, task]))
  const events = new Map(snapshot.events.map((event) => [event.eventId, event]))
  const delivered: WorkflowEffectReconcileResult['delivered'] = []

  for (const candidate of pending) {
    const effect = input.stateStore.workflowRuntime.leaseEffectIntent(candidate.effectId)
    if (effect === undefined) {
      continue
    }

    try {
      const task = tasks.get(effect.taskId)
      const sourceEvent = events.get(effect.sourceEventId)
      if (task === undefined) {
        throw new Error(`workflow effect task missing: ${effect.taskId}`)
      }
      if (sourceEvent === undefined) {
        throw new Error(`workflow effect source event missing: ${effect.sourceEventId}`)
      }

      const result = deliverEffect({ coordStore: input.coordStore, task, sourceEvent, effect })
      input.stateStore.workflowRuntime.markEffectIntentDelivered(effect.effectId)
      delivered.push({ effectId: effect.effectId, ...(result !== undefined ? { result } : {}) })
    } catch (error) {
      input.stateStore.workflowRuntime.markEffectIntentFailed(effect.effectId)
      throw error
    }
  }

  return { scanned: pending.length, delivered }
}
