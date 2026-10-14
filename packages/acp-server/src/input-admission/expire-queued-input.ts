import type { InputQueueItem } from 'acp-core'

import type { ResolvedAcpServerDeps } from '../deps.js'
import { admissionStatusForQueueStatus } from './admission-status.js'
import { recordInputAdmissionEvent } from './input-admission-events.js'

/**
 * Expire one queued input whose session context was dropped: the queue item,
 * its run and its admission all move to expired, and the expiry is recorded.
 * Shared by `POST /v1/sessions/reset` and the mobile restart (T-10850).
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
