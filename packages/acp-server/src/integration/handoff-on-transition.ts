import { type SessionRef, normalizeSessionRef } from 'agent-scope'
import { type AppendEventResult, appendEvent } from 'coordination-substrate'

import { AcpHttpError } from '../http.js'

export function shouldDeclareTesterHandoff(input: {
  fromPhase: string
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

export function appendTesterHandoffOnTransition(input: {
  coordStore: Parameters<typeof appendEvent>[0]
  projectId: string
  taskId: string
  fromPhase: string
  toPhase: string
  actor: { agentId: string; role: string }
  roleMap: Record<string, string>
  idempotencyKey?: string | undefined
}): AppendEventResult {
  const testerAgentId = input.roleMap['tester']?.trim()
  if (!testerAgentId) {
    throw new AcpHttpError(422, 'handoff_target_missing', 'tester role assignment is required')
  }

  const testerSessionRef = buildTesterSessionRef({
    testerAgentId,
    projectId: input.projectId,
    taskId: input.taskId,
  })

  return appendEvent(input.coordStore, {
    projectId: input.projectId,
    ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
    event: {
      ts: new Date().toISOString(),
      kind: 'handoff.declared',
      actor: { kind: 'agent', agentId: input.actor.agentId },
      semanticSession: testerSessionRef,
      participants: [
        { kind: 'agent', agentId: input.actor.agentId },
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
        actorRole: input.actor.role,
      },
    },
    handoff: {
      taskId: input.taskId,
      from: { kind: 'agent', agentId: input.actor.agentId },
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
  })
}
