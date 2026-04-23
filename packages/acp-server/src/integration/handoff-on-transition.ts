import { type SessionRef, normalizeSessionRef } from 'agent-scope'
import type { AppendEventCommand } from 'coordination-substrate'

import { AcpHttpError } from '../http.js'

export type TesterTransitionOutboxPayload = {
  transitionTimestamp: string
  actor: {
    agentId: string
    role: string
    scopeRef?: string | undefined
  }
  testerAgentId: string
}

export function shouldDeclareTesterHandoff(input: {
  fromPhase: string | null
  toPhase: string
  roleMap: Record<string, string>
  riskClass?: string | undefined
  requestHandoff?: boolean | undefined
}): boolean {
  if (input.requestHandoff === true) {
    return true
  }

  return (
    input.fromPhase === 'red' &&
    input.toPhase === 'green' &&
    input.riskClass !== 'low' &&
    typeof input.roleMap['tester'] === 'string' &&
    input.roleMap['tester'].trim().length > 0
  )
}

export function buildTesterSessionRef(input: {
  testerAgentId: string
  projectId: string
  taskId: string
}): SessionRef {
  return normalizeSessionRef({
    scopeRef: `agent:${input.testerAgentId}:project:${input.projectId}:task:${input.taskId}:role:tester`,
    laneRef: 'main',
  })
}

export function buildTesterTransitionOutboxPayload(input: {
  transitionTimestamp: string
  actor: { agentId: string; role: string }
  roleMap: Record<string, string>
}): TesterTransitionOutboxPayload {
  const testerAgentId = input.roleMap['tester']?.trim()
  if (!testerAgentId) {
    throw new AcpHttpError(422, 'handoff_target_missing', 'tester role assignment is required')
  }

  return {
    transitionTimestamp: input.transitionTimestamp,
    actor: input.actor,
    testerAgentId,
  }
}

export function buildTesterHandoffAppendEventCommand(input: {
  projectId: string
  taskId: string
  fromPhase: string | null
  toPhase: string
  payload: TesterTransitionOutboxPayload
  idempotencyKey?: string | undefined
}): AppendEventCommand {
  const { actor, testerAgentId } = input.payload

  const testerSessionRef = buildTesterSessionRef({
    testerAgentId,
    projectId: input.projectId,
    taskId: input.taskId,
  })

  return {
    projectId: input.projectId,
    ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
    event: {
      ts: input.payload.transitionTimestamp,
      kind: 'handoff.declared',
      actor: { kind: 'agent', agentId: actor.agentId },
      semanticSession: testerSessionRef,
      participants: [
        { kind: 'agent', agentId: actor.agentId },
        { kind: 'session', sessionRef: testerSessionRef },
      ],
      content: {
        kind: 'text',
        body: `Task ${input.taskId} moved ${input.fromPhase} -> ${input.toPhase} and is ready for tester review.`,
      },
      links: {
        taskId: input.taskId,
      },
      meta: {
        fromPhase: input.fromPhase,
        toPhase: input.toPhase,
        handoffRole: 'tester',
        actorRole: actor.role,
      },
    },
    handoff: {
      taskId: input.taskId,
      from: { kind: 'agent', agentId: actor.agentId },
      to: { kind: 'session', sessionRef: testerSessionRef },
      targetSession: testerSessionRef,
      kind: 'review',
      reason: `Task ${input.taskId} is ready for tester verification`,
    },
    wake: {
      sessionRef: testerSessionRef,
      reason: `Task ${input.taskId} is ready for tester verification`,
      ...(input.idempotencyKey !== undefined ? { dedupeKey: input.idempotencyKey } : {}),
    },
  }
}
