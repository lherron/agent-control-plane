import type { AcpStateStore, TransitionOutboxRecord } from 'acp-state-store'
import { type AppendEventResult, type CoordinationStore, appendEvent } from 'coordination-substrate'

import type {
  WrkfEventQueryParams,
  WrkfEventQueryResult,
  WrkfRoleBinding,
  WrkfTransitionEvent,
} from '@wrkq/client'

import {
  type TesterTransitionOutboxPayload,
  buildTesterHandoffAppendEventCommand,
} from './handoff-on-transition.js'

/**
 * The wrkf.event.query facade the reconciler depends on. This is the `event`
 * sub-facade of the shared WorkClient's wrkf namespace (`client.wrkf.event`).
 * The reconciler no longer touches the wrkq store's raw sqlite handle — it drives
 * entirely off this durable, replayable forward-model event feed
 * (T-04794 / T-04763 C-04677).
 */
export type WrkfEventFacade = {
  query(params?: WrkfEventQueryParams): Promise<WrkfEventQueryResult>
}

export type ReconcileTransitionOutboxResult = {
  scanned: number
  enqueued: number
  delivered: Array<{
    transitionEventId: string
    result: AppendEventResult
  }>
}

const DEFAULT_LIMIT = 100

/** Strip the `agent:` principal-ref prefix the real binary emits (e.g. "agent:larry" → "larry"). */
function stripAgentPrefix(value: string): string {
  return value.startsWith('agent:') ? value.slice('agent:'.length) : value
}

/**
 * Resolve the tester agent id from the forward role model. `matchingRoleBindings`
 * is populated by the wrkf server when `boundRole` + `includeRoleBindings=true`.
 * It is `null` (or empty) when no tester is bound — in that case the event is NOT
 * eligible and the caller must skip it (forward model, not legacy task_role_assignments).
 */
function resolveTesterAgentId(bindings: WrkfRoleBinding[] | null | undefined): string | undefined {
  if (!Array.isArray(bindings)) {
    return undefined
  }
  const testerBinding = bindings.find((binding) => binding.role === 'tester')
  if (testerBinding === undefined || typeof testerBinding.principal_ref !== 'string') {
    return undefined
  }
  const testerAgentId = stripAgentPrefix(testerBinding.principal_ref).trim()
  return testerAgentId.length > 0 ? testerAgentId : undefined
}

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

/**
 * Map a single forward-model transition event onto the outbox-append shape and
 * enqueue it. Returns true when a new entry was appended, false when skipped
 * (no forward tester binding, or already enqueued — idempotent by event id).
 */
function enqueueEvent(input: {
  event: WrkfTransitionEvent
  stateStore: AcpStateStore
}): boolean {
  const { event, stateStore } = input

  const testerAgentId = resolveTesterAgentId(event.matchingRoleBindings)
  if (testerAgentId === undefined) {
    // No tester bound in the forward model → not eligible (skip).
    return false
  }

  // Idempotency: keyed by the transition-event id. A second scan of the same
  // event (or a concurrent drain) must not enqueue a duplicate.
  if (stateStore.transitionOutbox.get(event.id) !== undefined) {
    return false
  }

  const actorAgentId = stripAgentPrefix(event.principal_ref ?? '')

  stateStore.transitionOutbox.append({
    transitionEventId: event.id,
    taskId: event.task.id,
    projectId: event.task.projectId ?? '',
    fromPhase: event.fromPhase ?? '',
    toPhase: event.toPhase ?? '',
    actor: { kind: 'agent', id: actorAgentId },
    payload: {
      transitionTimestamp: event.transitionedAt,
      actor: {
        agentId: actorAgentId,
        role: event.role ?? '',
      },
      testerAgentId,
    },
  })

  return true
}

/**
 * Scan phase: page through the durable forward-model event feed and enqueue an
 * outbox entry (keyed by transition-event id) for every eligible red→green
 * transition that ACP has not yet recorded.
 *
 * Replaces the old raw-SQLite `scanEligibleTransitions` (which prepared SQL on
 * the wrkq store's sqlite handle).
 * Eligibility — riskClass != 'low' and a tester role bound in the forward model —
 * is enforced server-side via the query filters; the client only re-derives the
 * tester agent id from `matchingRoleBindings` and skips events with no tester bound.
 */
async function reconcileMissing(input: {
  wrkfEvent: WrkfEventFacade
  stateStore: AcpStateStore
  limit: number
}): Promise<{ scanned: number; enqueued: number }> {
  let scanned = 0
  let enqueued = 0
  let cursor: string | undefined

  for (;;) {
    const page = await input.wrkfEvent.query({
      eventType: 'workflow.transitioned',
      fromPhase: 'red',
      toPhase: 'green',
      excludeRiskClass: 'low',
      boundRole: 'tester',
      includeRoleBindings: true,
      limit: input.limit,
      ...(cursor !== undefined ? { cursor } : {}),
    })

    for (const event of page.items) {
      scanned += 1
      if (enqueueEvent({ event, stateStore: input.stateStore })) {
        enqueued += 1
      }
    }

    if (!page.hasMore || page.nextCursor === undefined) {
      break
    }
    cursor = page.nextCursor
  }

  return { scanned, enqueued }
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

/**
 * Reconcile the transition outbox off the durable wrkf.event.query replay feed.
 *
 * Scan: page through every eligible {from=red,to=green,riskClass!=low,tester
 * bound} transition and enqueue a missing outbox entry keyed by transition-event
 * id. Drain: deliver pending entries to the coordination store (tester handoff +
 * wake), idempotent by transition-event id. Because the scan reads wrkq's durable
 * event log (not ACP-local state), a transition committed while ACP was down is
 * picked up on the next scan — the crash-recovery / replay-feed invariant.
 */
export async function reconcileTransitionOutbox(input: {
  wrkfEvent: WrkfEventFacade
  stateStore: AcpStateStore
  coordStore: CoordinationStore
  limit?: number
}): Promise<ReconcileTransitionOutboxResult> {
  const limit = input.limit ?? DEFAULT_LIMIT

  const { scanned, enqueued } = await reconcileMissing({
    wrkfEvent: input.wrkfEvent,
    stateStore: input.stateStore,
    limit,
  })
  const delivered = await drainOutbox({
    stateStore: input.stateStore,
    coordStore: input.coordStore,
    limit,
  })

  return {
    scanned,
    enqueued,
    delivered,
  }
}
