import type { AcpStateStore, TransitionOutboxRecord } from 'acp-state-store'
import { type AppendEventResult, type CoordinationStore, appendEvent } from 'coordination-substrate'
import type { WrkqStore } from 'wrkq-lib'

import {
  type TesterTransitionOutboxPayload,
  buildTesterHandoffAppendEventCommand,
} from './handoff-on-transition.js'

type TransitionScanRow = {
  transition_event_id: string
  task_id: string
  project_id: string
  from_phase: string | null
  to_phase: string
  transition_timestamp: string
  actor_agent_id: string
  actor_role: string
  tester_agent_id: string
}

export type ReconcileTransitionOutboxResult = {
  scanned: number
  enqueued: number
  delivered: Array<{
    transitionEventId: string
    result: AppendEventResult
  }>
}

const DEFAULT_SCAN_LIMIT = 100
const DEFAULT_DRAIN_LIMIT = 100

function toTesterTransitionOutboxPayload(
  payload: Readonly<Record<string, unknown>>
): TesterTransitionOutboxPayload {
  const transitionTimestamp = payload['transitionTimestamp']
  const testerAgentId = payload['testerAgentId']
  const actorValue = payload['actor']
  const actorRecord =
    typeof actorValue === 'object' && actorValue !== null
      ? (actorValue as Record<string, unknown>)
      : undefined
  const agentId = actorRecord?.['agentId']
  const role = actorRecord?.['role']
  const scopeRef = actorRecord?.['scopeRef']

  if (typeof transitionTimestamp !== 'string') {
    throw new Error('transition outbox payload missing transitionTimestamp')
  }

  if (typeof testerAgentId !== 'string' || testerAgentId.trim().length === 0) {
    throw new Error('transition outbox payload missing testerAgentId')
  }

  if (typeof agentId !== 'string' || typeof role !== 'string') {
    throw new Error('transition outbox payload missing actor')
  }

  return {
    transitionTimestamp,
    actor: {
      agentId,
      role,
      ...(typeof scopeRef === 'string' ? { scopeRef } : {}),
    },
    testerAgentId,
  }
}

function appendCoordinationForOutboxRow(
  coordStore: CoordinationStore,
  row: TransitionOutboxRecord
): AppendEventResult {
  return appendEvent(
    coordStore,
    buildTesterHandoffAppendEventCommand({
      projectId: row.projectId,
      taskId: row.taskId,
      fromPhase: row.fromPhase,
      toPhase: row.toPhase,
      payload: toTesterTransitionOutboxPayload(row.payload),
      idempotencyKey: row.transitionEventId,
    })
  )
}

function scanEligibleTransitions(
  wrkqStore: WrkqStore,
  limit: number
): readonly TransitionScanRow[] {
  return wrkqStore.sqlite
    .prepare(
      `SELECT tt.id AS transition_event_id,
              t.id AS task_id,
              c.id AS project_id,
              tt.from_phase,
              tt.to_phase,
              tt.transitioned_at AS transition_timestamp,
              actor.slug AS actor_agent_id,
              tt.actor_role,
              tester.slug AS tester_agent_id
         FROM task_transitions AS tt
         JOIN tasks AS t ON t.uuid = tt.task_uuid
         JOIN containers AS c ON c.uuid = t.project_uuid
         JOIN actors AS actor ON actor.uuid = tt.actor_uuid
         JOIN task_role_assignments AS tra
           ON tra.task_uuid = t.uuid
          AND tra.role = 'tester'
         JOIN actors AS tester ON tester.uuid = tra.actor_uuid
        WHERE tt.from_phase = 'red'
          AND tt.to_phase = 'green'
          AND t.risk_class != 'low'
     ORDER BY tt.transitioned_at ASC, tt.id ASC
        LIMIT ?`
    )
    .all(limit) as TransitionScanRow[]
}

function reconcileMissing(input: {
  wrkqStore: WrkqStore
  stateStore: AcpStateStore
  limit: number
}): { scanned: number; enqueued: number } {
  const candidates = scanEligibleTransitions(input.wrkqStore, input.limit)
  let enqueued = 0

  for (const candidate of candidates) {
    if (input.stateStore.transitionOutbox.get(candidate.transition_event_id) !== undefined) {
      continue
    }

    input.stateStore.transitionOutbox.append({
      transitionEventId: candidate.transition_event_id,
      taskId: candidate.task_id,
      projectId: candidate.project_id,
      fromPhase: candidate.from_phase ?? '',
      toPhase: candidate.to_phase,
      actor: { kind: 'agent', id: candidate.actor_agent_id },
      payload: {
        transitionTimestamp: candidate.transition_timestamp,
        actor: {
          agentId: candidate.actor_agent_id,
          role: candidate.actor_role,
        },
        testerAgentId: candidate.tester_agent_id,
      },
    })
    enqueued += 1
  }

  return {
    scanned: candidates.length,
    enqueued,
  }
}

async function drainOutbox(input: {
  stateStore: AcpStateStore
  coordStore: CoordinationStore
  limit: number
}): Promise<Array<{ transitionEventId: string; result: AppendEventResult }>> {
  const delivered: Array<{ transitionEventId: string; result: AppendEventResult }> = []

  for (let index = 0; index < input.limit; index += 1) {
    const leased = input.stateStore.transitionOutbox.leaseNext()
    if (leased === undefined) {
      break
    }

    try {
      const result = appendCoordinationForOutboxRow(input.coordStore, leased)
      input.stateStore.transitionOutbox.markDelivered(leased.transitionEventId)
      delivered.push({ transitionEventId: leased.transitionEventId, result })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      input.stateStore.transitionOutbox.markErrored(leased.transitionEventId, message)
      throw error
    }
  }

  return delivered
}

export async function reconcileTransitionOutbox(input: {
  wrkqStore: WrkqStore
  stateStore: AcpStateStore
  coordStore: CoordinationStore
}): Promise<ReconcileTransitionOutboxResult> {
  const { scanned, enqueued } = reconcileMissing({
    wrkqStore: input.wrkqStore,
    stateStore: input.stateStore,
    limit: DEFAULT_SCAN_LIMIT,
  })
  const delivered = await drainOutbox({
    stateStore: input.stateStore,
    coordStore: input.coordStore,
    limit: DEFAULT_DRAIN_LIMIT,
  })

  return {
    scanned,
    enqueued,
    delivered,
  }
}
