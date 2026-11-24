import type { InputQueueItem } from 'acp-core'
import type { HrcLifecycleEvent, HrcSessionRecord } from 'hrc-core'

import type { ResolvedAcpServerDeps } from '../deps.js'
import { admissionStatusForQueueStatus } from './admission-status.js'
import { recordInputAdmissionEvent } from './input-admission-events.js'

/**
 * Expire one queued input whose session context was dropped: the queue item,
 * its run and its admission all move to expired, and the expiry is recorded.
 * Shared by the reset route and the HRC generation follower.
 */
export function expireQueuedInput(
  deps: Pick<ResolvedAcpServerDeps, 'inputQueueStore' | 'runStore' | 'inputAdmissionStore'> &
    Parameters<typeof recordInputAdmissionEvent>[0],
  item: InputQueueItem,
  errorMessage: string
): void {
  const expiredItem = deps.inputQueueStore.update(item.queueItemId, { status: 'expired' })
  const expiredRun = deps.runStore.updateRun(item.runId, {
    status: 'cancelled',
    errorCode: 'reset_expired',
    errorMessage,
  })
  const expiredAdmission = deps.inputAdmissionStore.update(item.inputAttemptId, {
    status: admissionStatusForQueueStatus('expired'),
    currentState: { queueStatus: 'expired', reason: 'reset_policy', seq: item.seq },
  })
  recordInputAdmissionEvent(deps, {
    eventKind: 'input.queue.expired',
    scopeRef: item.scopeRef,
    laneRef: item.laneRef,
    inputAttemptId: item.inputAttemptId,
    admission: expiredAdmission,
    run: expiredRun,
    queueItem: expiredItem,
    reason: 'reset_policy',
  })
}

/** True while an item can still be delivered (and so can still be expired). */
export function isPendingQueueItem(item: InputQueueItem): boolean {
  return item.status === 'queued' || item.status === 'leased' || item.status === 'dispatching'
}

export function isInputComposedForDroppedContext(
  item: InputQueueItem,
  current: Pick<HrcSessionRecord, 'generation' | 'hostSessionId' | 'createdAt'>
): boolean {
  if (item.resetPolicy === 'follow_latest') return false
  if (item.expectedGeneration !== undefined && item.expectedGeneration !== current.generation) {
    return item.expectedGeneration < current.generation
  }
  if (item.expectedHostSessionId !== undefined) {
    return item.expectedHostSessionId !== current.hostSessionId
  }
  // Legacy items without a fence are compared to the successor's birth time.
  return (
    item.expectedGeneration === undefined &&
    current.generation > 1 &&
    Date.parse(item.createdAt) < Date.parse(current.createdAt)
  )
}

export function expireInputOnGenerationBump(
  deps: Parameters<typeof expireQueuedInput>[0],
  event: HrcLifecycleEvent
): void {
  if (
    event.evidenceOrigin === 'retained' ||
    event.generation <= 1 ||
    (event.eventKind !== 'session.created' && event.eventKind !== 'session.rotated')
  )
    return
  const laneRef = event.laneRef.replace(/^lane:/, '') || 'main'
  for (const item of deps.inputQueueStore.listForSession(event.scopeRef, laneRef)) {
    // A live dispatch owns its item until HRC answers its generation fence.
    if (
      item.status !== 'queued' ||
      !isInputComposedForDroppedContext(item, {
        hostSessionId: event.hostSessionId,
        generation: event.generation,
        createdAt: event.ts,
      })
    )
      continue
    expireQueuedInput(deps, item, 'queued input expired because the session generation changed')
  }
}

export async function reconcileQueuedInputContexts(
  deps: Parameters<typeof expireQueuedInput>[0],
  hrc: NonNullable<ResolvedAcpServerDeps['hrcClient']>,
  signal: AbortSignal
): Promise<void> {
  const bySession = new Map<string, InputQueueItem[]>()
  for (const item of deps.inputQueueStore.listQueuedForContextExpiry()) {
    const ref = `${item.scopeRef}/lane:${item.laneRef}`
    const items = bySession.get(ref) ?? []
    items.push(item)
    bySession.set(ref, items)
  }
  for (const [sessionRef, items] of bySession) {
    if (signal.aborted) return
    const current = await hrc.resolveSession({ sessionRef })
    if (signal.aborted) return
    if (!current.found) continue
    for (const item of items) {
      if (
        deps.inputQueueStore.getById(item.queueItemId)?.status === 'queued' &&
        isInputComposedForDroppedContext(item, current.session)
      ) {
        expireQueuedInput(deps, item, 'queued input expired because the session generation changed')
      }
    }
  }
}
