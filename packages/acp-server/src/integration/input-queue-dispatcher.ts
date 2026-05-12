import type { AttachmentRef, InputQueueItem, InputQueueStatus } from 'acp-core'
import { normalizeSessionRef } from 'agent-scope'

import type { LaunchRoleScopedRun, ResolvedAcpServerDeps } from '../deps.js'
import type { StoredRun } from '../domain/run-store.js'
import { recordInputAdmissionEvent } from '../input-admission/input-admission-events.js'
import { resolveLaunchIntent } from '../launch-role-scoped.js'
import { hasHrcAcceptedRunSince as defaultHasHrcAcceptedRunSince } from '../real-launcher.js'

export type InputQueueDispatcher = {
  start(): void
  stop(): Promise<void>
  runOnce(): Promise<void>
}

export type InputQueueDispatcherConfig = {
  intervalMs: number
  leaseOwner?: string | undefined
  stalePendingRunTimeoutMs?: number | undefined
  leaseTimeoutMs?: number | undefined
}

export type InputQueueDispatcherDeps = Pick<
  ResolvedAcpServerDeps,
  | 'adminStore'
  | 'hrcClient'
  | 'inputAdmissionStore'
  | 'inputQueueStore'
  | 'runStore'
  | 'runtimeResolver'
  | 'inputQueuePolicy'
> & {
  launchRoleScopedRun: NonNullable<LaunchRoleScopedRun>
  config: InputQueueDispatcherConfig
  hrcDbPath?: string | undefined
  hasHrcAcceptedRunSince?:
    | ((hrcDbPath: string, hostSessionId: string, since: string) => boolean)
    | undefined
}

function isRuntimeBusyError(error: unknown): boolean {
  const candidate = error as Record<string, unknown>
  return (
    candidate?.['code'] === 'runtime_busy' ||
    candidate?.['errorCode'] === 'runtime_busy' ||
    (error instanceof Error && error.message.toLowerCase().includes('runtime busy')) ||
    (error instanceof Error && error.message.toLowerCase().includes('active run'))
  )
}

function stalePendingRunTimeoutMs(deps: InputQueueDispatcherDeps): number {
  return deps.config.stalePendingRunTimeoutMs ?? 45_000
}

function leaseTimeoutMs(deps: InputQueueDispatcherDeps): number {
  return deps.config.leaseTimeoutMs ?? 600_000
}

type StaleBlockerKind = 'no_correlation' | 'partial_correlation'

type ClassifyStalePendingRunBlockerInput = {
  run: StoredRun
  siblings: readonly StoredRun[]
  timeoutMs: number
  hrcDbPath?: string | undefined
  hasHrcAcceptedRunSince?:
    | ((hrcDbPath: string, hostSessionId: string, since: string) => boolean)
    | undefined
}

function hasCredibleSiblingProgress(run: StoredRun, siblings: readonly StoredRun[]): boolean {
  return siblings.some((sibling) => {
    if (sibling.runId === run.runId) {
      return false
    }
    if (sibling.scopeRef !== run.scopeRef || sibling.laneRef !== run.laneRef) {
      return false
    }
    return (
      sibling.status === 'running' ||
      (sibling.status === 'pending' &&
        sibling.hrcRunId !== undefined &&
        sibling.runtimeId !== undefined)
    )
  })
}

function classifyStalePendingRunBlocker(
  input: ClassifyStalePendingRunBlockerInput
): StaleBlockerKind | undefined {
  const { run, siblings, timeoutMs, hrcDbPath } = input
  if (run.status !== 'pending') {
    return undefined
  }
  if (run.hrcRunId !== undefined || run.runtimeId !== undefined) {
    return undefined
  }
  if (Date.now() - new Date(run.updatedAt).getTime() <= timeoutMs) {
    return undefined
  }
  if (hasCredibleSiblingProgress(run, siblings)) {
    return undefined
  }
  const hasHrcAcceptedRunSince = input.hasHrcAcceptedRunSince ?? defaultHasHrcAcceptedRunSince
  if (
    hrcDbPath !== undefined &&
    run.hostSessionId !== undefined &&
    hasHrcAcceptedRunSince(hrcDbPath, run.hostSessionId, run.createdAt)
  ) {
    return undefined
  }
  return run.hostSessionId === undefined ? 'no_correlation' : 'partial_correlation'
}

function failStalePendingRunBlockers(deps: InputQueueDispatcherDeps): void {
  const timeoutMs = stalePendingRunTimeoutMs(deps)
  const runs = deps.runStore.listRuns()
  for (const run of runs) {
    const siblings = runs.filter(
      (candidate) =>
        candidate.runId !== run.runId &&
        candidate.scopeRef === run.scopeRef &&
        candidate.laneRef === run.laneRef
    )
    const blockerKind = classifyStalePendingRunBlocker({
      run,
      siblings,
      timeoutMs,
      hrcDbPath: deps.hrcDbPath,
      hasHrcAcceptedRunSince: deps.hasHrcAcceptedRunSince,
    })
    if (blockerKind === undefined) {
      continue
    }

    const errorMessage =
      blockerKind === 'no_correlation'
        ? `Run was blocking input queue dispatch, but no HRC launch correlation was recorded within ${Math.round(timeoutMs / 1000)}s`
        : `Run was blocking input queue dispatch with partial HRC session correlation but no turn/runtime correlation within ${Math.round(timeoutMs / 1000)}s`
    deps.runStore.updateRun(run.runId, {
      status: 'failed',
      errorCode: 'dispatch_timeout',
      errorMessage,
    })

    const queueItem = deps.inputQueueStore.getByRunId(run.runId)
    if (
      queueItem !== undefined &&
      (queueItem.status === 'queued' ||
        queueItem.status === 'leased' ||
        queueItem.status === 'dispatching')
    ) {
      deps.inputQueueStore.update(queueItem.queueItemId, {
        status: 'failed',
        lastErrorCode: 'dispatch_timeout',
        lastErrorMessage: errorMessage,
      })
    }
  }
}

function isExpiredLeasedHead(item: InputQueueItem, timeoutMs: number): boolean {
  if (item.status !== 'leased' && item.status !== 'dispatching') {
    return false
  }
  if (item.leasedAt === undefined) {
    return false
  }
  return Date.now() - new Date(item.leasedAt).getTime() > timeoutMs
}

function failExpiredLeasedHead(deps: InputQueueDispatcherDeps, head: InputQueueItem): boolean {
  const timeoutMs = leaseTimeoutMs(deps)
  if (!isExpiredLeasedHead(head, timeoutMs)) {
    return false
  }

  const errorMessage = `Queue item lease expired: leased at ${head.leasedAt} exceeded ${Math.round(timeoutMs / 1000)}s with no terminal run state`
  const failedQueueItem = deps.inputQueueStore.update(head.queueItemId, {
    status: 'failed',
    lastErrorCode: 'lease_timeout',
    lastErrorMessage: errorMessage,
  })

  const run = deps.runStore.getRun(head.runId)
  let updatedRun = run
  if (
    run !== undefined &&
    run.status !== 'completed' &&
    run.status !== 'failed' &&
    run.status !== 'cancelled'
  ) {
    updatedRun = deps.runStore.updateRun(head.runId, {
      status: 'failed',
      errorCode: 'lease_timeout',
      errorMessage,
    })
  }

  const admission = deps.inputAdmissionStore.getByInputAttemptId(head.inputAttemptId)
  const updatedAdmission =
    admission !== undefined
      ? deps.inputAdmissionStore.update(head.inputAttemptId, {
          status: 'failed',
          currentState: {
            ...(admission.currentState ?? {}),
            queueStatus: 'failed',
            errorCode: 'lease_timeout',
            seq: head.seq,
          },
        })
      : undefined

  recordInputAdmissionEvent(deps, {
    eventKind: 'input.queue.lease_expired',
    scopeRef: head.scopeRef,
    laneRef: head.laneRef,
    inputAttemptId: head.inputAttemptId,
    ...(updatedAdmission !== undefined ? { admission: updatedAdmission } : {}),
    ...(updatedRun !== undefined ? { run: updatedRun } : {}),
    queueItem: failedQueueItem,
    payload: {
      queueItemId: head.queueItemId,
      runId: head.runId,
      leasedAt: head.leasedAt,
      leaseOwner: head.leaseOwner,
      timeoutMs,
    },
  })
  return true
}

function terminalQueueStatusForRun(run: StoredRun): InputQueueStatus | undefined {
  if (run.status === 'completed') {
    return 'completed'
  }
  if (run.status === 'failed') {
    return 'failed'
  }
  if (run.status === 'cancelled') {
    return 'cancelled'
  }
  return undefined
}

function reconcileTerminalQueueItem(deps: InputQueueDispatcherDeps, item: InputQueueItem): boolean {
  const run = deps.runStore.getRun(item.runId)
  if (run === undefined) {
    return false
  }

  const queueStatus = terminalQueueStatusForRun(run)
  if (queueStatus === undefined) {
    return false
  }

  const queueItem = deps.inputQueueStore.update(item.queueItemId, {
    status: queueStatus,
    ...(run.errorCode !== undefined ? { lastErrorCode: run.errorCode } : {}),
    ...(run.errorMessage !== undefined ? { lastErrorMessage: run.errorMessage } : {}),
  })
  const admission = deps.inputAdmissionStore.getByInputAttemptId(item.inputAttemptId)
  const updatedAdmission =
    admission !== undefined
      ? deps.inputAdmissionStore.update(item.inputAttemptId, {
          status: run.status,
          currentState: {
            ...(admission.currentState ?? {}),
            queueStatus,
            runStatus: run.status,
            seq: item.seq,
            ...(run.errorCode !== undefined ? { errorCode: run.errorCode } : {}),
            ...(run.errorMessage !== undefined ? { errorMessage: run.errorMessage } : {}),
          },
        })
      : undefined

  recordInputAdmissionEvent(deps, {
    eventKind: 'input.queue.reconciled_terminal',
    scopeRef: item.scopeRef,
    laneRef: item.laneRef,
    inputAttemptId: item.inputAttemptId,
    ...(updatedAdmission !== undefined ? { admission: updatedAdmission } : {}),
    run,
    queueItem,
  })
  return true
}

function sameSessionHasActiveRun(deps: InputQueueDispatcherDeps, item: InputQueueItem): boolean {
  const sessionRef = normalizeSessionRef({ scopeRef: item.scopeRef, laneRef: item.laneRef })
  return deps.runStore
    .listRunsForSession(sessionRef)
    .some(
      (run) => run.runId !== item.runId && (run.status === 'pending' || run.status === 'running')
    )
}

function attachmentRefsFromRunMetadata(
  metadata: Readonly<Record<string, unknown>> | undefined
): AttachmentRef[] | undefined {
  const meta = metadata?.['meta']
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) {
    return undefined
  }
  const attachments = (meta as Record<string, unknown>)['resolvedAttachments']
  return Array.isArray(attachments) ? (attachments as AttachmentRef[]) : undefined
}

function promptFromRunMetadata(metadata: Readonly<Record<string, unknown>> | undefined): string {
  const content = metadata?.['content']
  return typeof content === 'string' ? content : ''
}

function appendAttachmentPathsToPrompt(
  prompt: string,
  resolved: AttachmentRef[] | undefined
): string {
  if (resolved === undefined || resolved.length === 0) return prompt
  const filePaths = resolved
    .filter((a): a is AttachmentRef & { path: string } => a.kind === 'file' && !!a.path)
    .map((a) => `[attached file: ${a.path}]`)
  if (filePaths.length === 0) return prompt
  return `${prompt}\n\n${filePaths.join('\n')}`
}

function queueItemExpiredByTtl(deps: InputQueueDispatcherDeps, item: InputQueueItem): boolean {
  const ttlMs = deps.inputQueuePolicy.ttlMs
  if (ttlMs === undefined) {
    return false
  }
  return Date.now() - new Date(item.createdAt).getTime() > ttlMs
}

async function queueItemExpiredByResetPolicy(
  deps: InputQueueDispatcherDeps,
  item: InputQueueItem
): Promise<boolean> {
  if (
    item.resetPolicy === 'follow_latest' ||
    (item.expectedHostSessionId === undefined && item.expectedGeneration === undefined) ||
    deps.hrcClient === undefined
  ) {
    return false
  }

  const resolved = await deps.hrcClient.resolveSession({
    sessionRef: `${item.scopeRef}/lane:${item.laneRef}`,
  })
  return (
    (item.expectedHostSessionId !== undefined &&
      resolved.hostSessionId !== item.expectedHostSessionId) ||
    (item.expectedGeneration !== undefined && resolved.generation !== item.expectedGeneration)
  )
}

function expireQueueItem(
  deps: InputQueueDispatcherDeps,
  item: InputQueueItem,
  reason: string
): void {
  const expiredItem = deps.inputQueueStore.update(item.queueItemId, {
    status: 'expired',
    lastErrorCode: reason,
    lastErrorMessage: reason,
  })
  const expiredRun = deps.runStore.updateRun(item.runId, {
    status: 'cancelled',
    errorCode: reason,
    errorMessage: reason,
  })
  const expiredAdmission = deps.inputAdmissionStore.update(item.inputAttemptId, {
    status: 'expired',
    currentState: { queueStatus: 'expired', reason, seq: item.seq },
  })
  recordInputAdmissionEvent(deps, {
    eventKind: 'input.queue.expired',
    scopeRef: item.scopeRef,
    laneRef: item.laneRef,
    inputAttemptId: item.inputAttemptId,
    admission: expiredAdmission,
    run: expiredRun,
    queueItem: expiredItem,
    reason,
  })
}

export function createInputQueueDispatcher(deps: InputQueueDispatcherDeps): InputQueueDispatcher {
  let running = false
  let inflight: Promise<void> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  async function dispatchItem(item: InputQueueItem): Promise<void> {
    if (queueItemExpiredByTtl(deps, item)) {
      expireQueueItem(deps, item, 'input_queue_ttl_expired')
      return
    }
    if (await queueItemExpiredByResetPolicy(deps, item)) {
      expireQueueItem(deps, item, 'reset_policy')
      return
    }

    let head = deps.inputQueueStore.getHead(item.scopeRef, item.laneRef)
    while (head !== undefined && head.queueItemId !== item.queueItemId) {
      if (reconcileTerminalQueueItem(deps, head)) {
        head = deps.inputQueueStore.getHead(item.scopeRef, item.laneRef)
        continue
      }
      if (failExpiredLeasedHead(deps, head)) {
        head = deps.inputQueueStore.getHead(item.scopeRef, item.laneRef)
        continue
      }
      break
    }
    if (head?.queueItemId !== item.queueItemId) {
      return
    }
    if (sameSessionHasActiveRun(deps, item)) {
      return
    }

    const run = deps.runStore.getRun(item.runId)
    if (run === undefined || run.status !== 'queued') {
      return
    }

    const leaseOwner = deps.config.leaseOwner ?? 'acp-input-queue-dispatcher'
    const leased = deps.inputQueueStore.update(item.queueItemId, {
      status: 'dispatching',
      leasedAt: new Date().toISOString(),
      leaseOwner,
      attempts: item.attempts + 1,
    })
    const pendingRun = deps.runStore.updateRun(item.runId, { status: 'pending' })
    const dispatchingAdmission = deps.inputAdmissionStore.update(item.inputAttemptId, {
      status: 'dispatching',
      currentState: { queueStatus: 'dispatching', seq: item.seq },
    })
    recordInputAdmissionEvent(deps, {
      eventKind: 'input.dispatching',
      scopeRef: item.scopeRef,
      laneRef: item.laneRef,
      inputAttemptId: item.inputAttemptId,
      admission: dispatchingAdmission,
      run: pendingRun,
      queueItem: leased,
    })

    const sessionRef = normalizeSessionRef({ scopeRef: item.scopeRef, laneRef: item.laneRef })
    const attachments = attachmentRefsFromRunMetadata(pendingRun.metadata)
    const prompt = appendAttachmentPathsToPrompt(
      promptFromRunMetadata(pendingRun.metadata),
      attachments
    )
    const intent = await resolveLaunchIntent(
      { runtimeResolver: deps.runtimeResolver } as Parameters<typeof resolveLaunchIntent>[0],
      sessionRef,
      {
        initialPrompt: prompt,
        ...(attachments !== undefined ? { attachments } : {}),
      }
    )

    try {
      await deps.launchRoleScopedRun({
        sessionRef,
        intent,
        acpRunId: item.runId,
        inputAttemptId: item.inputAttemptId,
        runStore: deps.runStore,
        waitForCompletion: false,
      })
      const launchedRun = deps.runStore.getRun(item.runId) ?? pendingRun
      const runningQueueItem = deps.inputQueueStore.update(leased.queueItemId, {
        status: 'running',
      })
      const runningAdmission = deps.inputAdmissionStore.update(item.inputAttemptId, {
        status: launchedRun.status,
        currentState: { queueStatus: 'running', runStatus: launchedRun.status, seq: item.seq },
      })
      recordInputAdmissionEvent(deps, {
        eventKind: 'input.started',
        scopeRef: item.scopeRef,
        laneRef: item.laneRef,
        inputAttemptId: item.inputAttemptId,
        admission: runningAdmission,
        run: launchedRun,
        queueItem: runningQueueItem,
      })
    } catch (error) {
      if (isRuntimeBusyError(error)) {
        deps.runStore.updateRun(item.runId, {
          status: 'queued',
          errorCode: 'runtime_busy',
          errorMessage: error instanceof Error ? error.message : String(error),
        })
        deps.inputQueueStore.update(leased.queueItemId, {
          status: 'queued',
          notBeforeAt: new Date(Date.now() + 2_000).toISOString(),
          lastErrorCode: 'runtime_busy',
          lastErrorMessage: error instanceof Error ? error.message : String(error),
        })
        deps.inputAdmissionStore.update(item.inputAttemptId, {
          status: 'queued',
          currentState: { queueStatus: 'queued', reason: 'runtime_busy', seq: item.seq },
        })
        return
      }

      const errorMessage = error instanceof Error ? error.message : String(error)
      deps.runStore.updateRun(item.runId, {
        status: 'failed',
        errorCode: 'launch_failed',
        errorMessage,
      })
      deps.inputQueueStore.update(leased.queueItemId, {
        status: 'failed',
        lastErrorCode: 'launch_failed',
        lastErrorMessage: errorMessage,
      })
      deps.inputAdmissionStore.update(item.inputAttemptId, {
        status: 'failed',
        currentState: { queueStatus: 'failed', errorCode: 'launch_failed', seq: item.seq },
      })
    }
  }

  async function runOnce(): Promise<void> {
    failStalePendingRunBlockers(deps)

    // Fair-by-session: scan one queued head per (scopeRef, laneRef) so blocked sessions
    // never starve later ones, even when total queued items exceed the global page limit.
    const items = deps.inputQueueStore.listDispatchableSessionHeads()

    for (const item of items) {
      try {
        await dispatchItem(item)
      } catch (error) {
        console.error(
          `[input-queue-dispatcher] error dispatching queue item ${item.queueItemId} for run ${item.runId}:`,
          error instanceof Error ? error.message : String(error)
        )
      }
    }
  }

  function scheduleNext(): void {
    if (!running) {
      return
    }
    timer = setTimeout(() => {
      const pass = runOnce()
      inflight = pass
      void pass
        .catch((error) => {
          console.error(
            '[input-queue-dispatcher] loop error:',
            error instanceof Error ? error.message : String(error)
          )
        })
        .then(() => {
          inflight = undefined
          scheduleNext()
        })
    }, deps.config.intervalMs)
  }

  return {
    start(): void {
      running = true
      const pass = runOnce()
      inflight = pass
      void pass
        .catch((error) => {
          console.error(
            '[input-queue-dispatcher] startup sweep error:',
            error instanceof Error ? error.message : String(error)
          )
        })
        .then(() => {
          inflight = undefined
          scheduleNext()
        })
    },
    async stop(): Promise<void> {
      running = false
      if (timer !== undefined) {
        clearTimeout(timer)
      }
      if (inflight !== undefined) {
        await inflight
      }
    },
    runOnce,
  }
}

export const __testing = {
  classifyStalePendingRunBlocker,
  sameSessionHasActiveRun,
}
