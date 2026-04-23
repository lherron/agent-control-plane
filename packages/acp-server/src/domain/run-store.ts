import { randomUUID } from 'node:crypto'

import type { Actor, Run } from 'acp-core'
import type { SessionRef } from 'agent-scope'

export type DispatchFence = {
  expectedHostSessionId?: string | undefined
  expectedGeneration?: number | undefined
  followLatest?: boolean | undefined
}

export type StoredRun = Run & {
  updatedAt: string
  hrcRunId?: string | undefined
  hostSessionId?: string | undefined
  generation?: number | undefined
  runtimeId?: string | undefined
  transport?: string | undefined
  errorCode?: string | undefined
  errorMessage?: string | undefined
  dispatchFence?: DispatchFence | undefined
}

export type UpdateRunInput = {
  status?: Run['status'] | undefined
  hrcRunId?: string | undefined
  hostSessionId?: string | undefined
  generation?: number | undefined
  runtimeId?: string | undefined
  transport?: string | undefined
  errorCode?: string | undefined
  errorMessage?: string | undefined
  metadata?: Readonly<Record<string, unknown>> | undefined
}

export interface RunStore {
  createRun(input: {
    sessionRef: SessionRef
    taskId?: string | undefined
    actor?: Actor | undefined
    metadata?: Readonly<Record<string, unknown>> | undefined
  }): StoredRun
  getRun(runId: string): StoredRun | undefined
  listRuns(): readonly StoredRun[]
  listRunsForSession(sessionRef: SessionRef): readonly StoredRun[]
  updateRun(runId: string, patch: UpdateRunInput): StoredRun
  setDispatchFence(runId: string, dispatchFence: DispatchFence): StoredRun
}

export class InMemoryRunStore implements RunStore {
  private readonly runs = new Map<string, StoredRun>()

  createRun(input: {
    sessionRef: SessionRef
    taskId?: string | undefined
    actor?: Actor | undefined
    metadata?: Readonly<Record<string, unknown>> | undefined
  }): StoredRun {
    const actor = input.actor ?? { kind: 'system', id: 'acp-local' }
    const timestamp = new Date().toISOString()
    const run: StoredRun = {
      runId: `run_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      scopeRef: input.sessionRef.scopeRef,
      laneRef: input.sessionRef.laneRef,
      actor: structuredClone(actor),
      status: 'pending',
      createdAt: timestamp,
      updatedAt: timestamp,
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    }

    this.runs.set(run.runId, run)
    return structuredClone(run)
  }

  getRun(runId: string): StoredRun | undefined {
    const run = this.runs.get(runId)
    return run === undefined ? undefined : structuredClone(run)
  }

  listRuns(): readonly StoredRun[] {
    return [...this.runs.values()].map((run) => structuredClone(run))
  }

  listRunsForSession(sessionRef: SessionRef): readonly StoredRun[] {
    return [...this.runs.values()]
      .filter((run) => run.scopeRef === sessionRef.scopeRef && run.laneRef === sessionRef.laneRef)
      .map((run) => structuredClone(run))
  }

  updateRun(runId: string, patch: UpdateRunInput): StoredRun {
    const run = this.runs.get(runId)
    if (run === undefined) {
      throw new Error(`run not found: ${runId}`)
    }

    const next: StoredRun = {
      ...run,
      ...('status' in patch ? { status: patch.status ?? run.status } : {}),
      ...('hrcRunId' in patch
        ? patch.hrcRunId === undefined
          ? {}
          : { hrcRunId: patch.hrcRunId }
        : {}),
      ...('hostSessionId' in patch
        ? patch.hostSessionId === undefined
          ? {}
          : { hostSessionId: patch.hostSessionId }
        : {}),
      ...('generation' in patch
        ? patch.generation === undefined
          ? {}
          : { generation: patch.generation }
        : {}),
      ...('runtimeId' in patch
        ? patch.runtimeId === undefined
          ? {}
          : { runtimeId: patch.runtimeId }
        : {}),
      ...('transport' in patch
        ? patch.transport === undefined
          ? {}
          : { transport: patch.transport }
        : {}),
      ...('errorCode' in patch
        ? patch.errorCode === undefined
          ? {}
          : { errorCode: patch.errorCode }
        : {}),
      ...('errorMessage' in patch
        ? patch.errorMessage === undefined
          ? {}
          : { errorMessage: patch.errorMessage }
        : {}),
      ...('metadata' in patch
        ? patch.metadata === undefined
          ? {}
          : { metadata: patch.metadata }
        : {}),
      updatedAt: new Date().toISOString(),
    }

    this.runs.set(runId, next)
    return structuredClone(next)
  }

  setDispatchFence(runId: string, dispatchFence: DispatchFence): StoredRun {
    const run = this.runs.get(runId)
    if (run === undefined) {
      throw new Error(`run not found: ${runId}`)
    }

    const next: StoredRun = {
      ...run,
      dispatchFence: structuredClone(dispatchFence),
      updatedAt: new Date().toISOString(),
    }

    this.runs.set(runId, next)
    return structuredClone(next)
  }
}
