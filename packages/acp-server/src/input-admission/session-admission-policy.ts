import type { InputResetPolicy } from 'acp-core'
import type { SessionRef } from 'agent-scope'
import type { ResolvedAcpServerDeps } from '../deps.js'
import type { StoredRun } from '../domain/run-store.js'

export function isSessionBusy(deps: ResolvedAcpServerDeps, sessionRef: SessionRef): boolean {
  const activeRun = deps.runStore
    .listRunsForSession(sessionRef)
    .some((run) => run.status === 'pending' || run.status === 'running')
  if (activeRun) {
    return true
  }

  const head = deps.inputQueueStore.getHead(sessionRef.scopeRef, sessionRef.laneRef)
  return head !== undefined
}

function activeQueueDepth(deps: ResolvedAcpServerDeps, scopeRef: string, laneRef: string): number {
  return deps.inputQueueStore
    .listForSession(scopeRef, laneRef)
    .filter(
      (item) =>
        item.status === 'queued' || item.status === 'leased' || item.status === 'dispatching'
    ).length
}

export function queueDepthExceeded(
  deps: ResolvedAcpServerDeps,
  scopeRef: string,
  laneRef: string
): boolean {
  const maxDepth = deps.inputQueuePolicy.maxDepth
  return maxDepth !== undefined && activeQueueDepth(deps, scopeRef, laneRef) >= maxDepth
}

export function queueFenceFromResetPolicy(
  resetPolicy: InputResetPolicy,
  activeRun: StoredRun | undefined
): {
  expectedHostSessionId?: string | undefined
  expectedGeneration?: number | undefined
} {
  if (resetPolicy === 'follow_latest' || activeRun === undefined) {
    return {}
  }
  return {
    ...(activeRun.hostSessionId !== undefined
      ? { expectedHostSessionId: activeRun.hostSessionId }
      : {}),
    ...(activeRun.generation !== undefined ? { expectedGeneration: activeRun.generation } : {}),
  }
}

function isActiveRun(run: StoredRun): boolean {
  return run.status === 'running' || run.status === 'pending'
}

export function findTargetActiveRun(
  deps: ResolvedAcpServerDeps,
  sessionRef: SessionRef
): StoredRun | undefined {
  return deps.runStore.listRunsForSession(sessionRef).filter(isActiveRun).at(-1)
}
