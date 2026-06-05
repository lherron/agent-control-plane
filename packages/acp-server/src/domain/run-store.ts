import { randomUUID } from 'node:crypto'

import type { Actor, Run } from 'acp-core'
import { RunCorrelationConflictError, deriveRunId } from 'acp-state-store'
import type { SessionRef } from 'agent-scope'

export { RunCorrelationConflictError, deriveRunId } from 'acp-state-store'

export type CreateOrGetRunInput = {
  sessionRef: SessionRef
  wrkfTaskId: string
  wrkfInstanceId: string
  wrkfRunId: string
  workflowRef: string
  role: string
  actor?: Actor | undefined
  status?: Run['status'] | undefined
}

export type CreateOrGetRunResult = {
  run: StoredRun
  created: boolean
}

const RUN_CORRELATION_CONFLICT_FIELDS = ['wrkfTaskId', 'wrkfRunId', 'workflowRef', 'role'] as const

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
  afterHrcSeq?: number | undefined
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
  afterHrcSeq?: number | undefined
}

export interface RunStore {
  createRun(input: {
    sessionRef: SessionRef
    taskId?: string | undefined
    actor?: Actor | undefined
    status?: Run['status'] | undefined
    metadata?: Readonly<Record<string, unknown>> | undefined
  }): StoredRun
  createOrGetRun(input: CreateOrGetRunInput): CreateOrGetRunResult
  getRun(runId: string): StoredRun | undefined
  listRuns(): readonly StoredRun[]
  listRunsForSession(sessionRef: SessionRef): readonly StoredRun[]
  listRunsByStatus(status: Run['status']): readonly StoredRun[]
  updateRun(runId: string, patch: UpdateRunInput): StoredRun
  setDispatchFence(runId: string, dispatchFence: DispatchFence): StoredRun
}

export class InMemoryRunStore implements RunStore {
  private readonly runs = new Map<string, StoredRun>()

  createRun(input: {
    sessionRef: SessionRef
    taskId?: string | undefined
    actor?: Actor | undefined
    status?: Run['status'] | undefined
    metadata?: Readonly<Record<string, unknown>> | undefined
  }): StoredRun {
    const actor = input.actor ?? { kind: 'system', id: 'acp-local' }
    const timestamp = new Date().toISOString()
    const run: StoredRun = {
      runId: `run_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      scopeRef: input.sessionRef.scopeRef,
      laneRef: input.sessionRef.laneRef,
      actor: structuredClone(actor),
      status: input.status ?? 'pending',
      createdAt: timestamp,
      updatedAt: timestamp,
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    }

    this.runs.set(run.runId, run)
    return structuredClone(run)
  }

  createOrGetRun(input: CreateOrGetRunInput): CreateOrGetRunResult {
    const runId = deriveRunId(input.wrkfRunId)
    const existing = this.runs.get(runId)
    if (existing !== undefined) {
      const metadata = existing.metadata ?? {}
      for (const field of RUN_CORRELATION_CONFLICT_FIELDS) {
        const expected = (metadata as Record<string, unknown>)[field]
        const actual = input[field]
        if (expected !== actual) {
          throw new RunCorrelationConflictError({ runId, field, expected, actual })
        }
      }
      return { run: structuredClone(existing), created: false }
    }

    const actor = input.actor ?? { kind: 'system', id: 'acp-local' }
    const timestamp = new Date().toISOString()
    const run: StoredRun = {
      runId,
      scopeRef: input.sessionRef.scopeRef,
      laneRef: input.sessionRef.laneRef,
      actor: structuredClone(actor),
      status: input.status ?? 'pending',
      createdAt: timestamp,
      updatedAt: timestamp,
      metadata: {
        source: 'wrkf',
        wrkfTaskId: input.wrkfTaskId,
        wrkfInstanceId: input.wrkfInstanceId,
        wrkfRunId: input.wrkfRunId,
        workflowRef: input.workflowRef,
        role: input.role,
      },
    }

    this.runs.set(run.runId, run)
    return { run: structuredClone(run), created: true }
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

  listRunsByStatus(status: Run['status']): readonly StoredRun[] {
    return [...this.runs.values()]
      .filter((run) => run.status === status)
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
      ...('afterHrcSeq' in patch
        ? patch.afterHrcSeq === undefined
          ? {}
          : { afterHrcSeq: patch.afterHrcSeq }
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
