import type { AttachmentRef, InputQueueItem } from 'acp-core'
import { normalizeSessionRef } from 'agent-scope'

import type { LaunchRoleScopedRun, ResolvedAcpServerDeps } from '../deps.js'
import { recordInputAdmissionEvent } from '../input-admission/input-admission-events.js'
import { resolveLaunchIntent } from '../launch-role-scoped.js'

export type InputQueueDispatcher = {
  start(): void
  stop(): Promise<void>
  runOnce(): Promise<void>
}

export type InputQueueDispatcherConfig = {
  intervalMs: number
  leaseOwner?: string | undefined
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

    const head = deps.inputQueueStore.getHead(item.scopeRef, item.laneRef)
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
    const items = deps.inputQueueStore.listDispatchable()
    const seenSessions = new Set<string>()

    for (const item of items) {
      const key = `${item.scopeRef}\u0000${item.laneRef}`
      if (seenSessions.has(key)) {
        continue
      }
      seenSessions.add(key)
      await dispatchItem(item)
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
        .catch(() => {})
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
        .catch(() => {})
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
