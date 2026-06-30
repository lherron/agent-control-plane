import { randomUUID } from 'node:crypto'

import type { Actor, Run } from 'acp-core'
import { RunCorrelationConflictError, deriveRunId } from 'acp-state-store'
import type { SessionRef } from 'agent-scope'

import { readRecord } from '../wrkf/value.js'

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

export type AcquireLaunchClaimInput = {
  runId: string
  claimId: string
  idempotencyKey: string
  wrkfRunId: string
  claimedAt?: string | undefined
}

export type AcquireLaunchClaimResult = {
  run: StoredRun
  acquired: boolean
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
  errorCode?: string | null | undefined
  errorMessage?: string | null | undefined
  metadata?: Readonly<Record<string, unknown>> | undefined
  afterHrcSeq?: number | undefined
}

type DefinedRunPatch = Partial<
  Pick<
    StoredRun,
    | 'hrcRunId'
    | 'hostSessionId'
    | 'generation'
    | 'runtimeId'
    | 'transport'
    | 'errorCode'
    | 'errorMessage'
    | 'metadata'
    | 'afterHrcSeq'
  >
>

export interface RunStore {
  createRun(input: {
    sessionRef: SessionRef
    taskId?: string | undefined
    actor?: Actor | undefined
    status?: Run['status'] | undefined
    metadata?: Readonly<Record<string, unknown>> | undefined
  }): StoredRun
  createOrGetRun(input: CreateOrGetRunInput): CreateOrGetRunResult
  acquireLaunchClaim(input: AcquireLaunchClaimInput): AcquireLaunchClaimResult
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

  acquireLaunchClaim(input: AcquireLaunchClaimInput): AcquireLaunchClaimResult {
    const run = this.runs.get(input.runId)
    if (run === undefined) {
      throw new Error(`run not found: ${input.runId}`)
    }

    const existingClaim = readRecord(run.metadata?.['wrkfLaunchClaim'])
    const existingBind = readRecord(run.metadata?.['wrkfExternalBind'])
    if (
      run.hrcRunId !== undefined ||
      existingClaim?.['status'] === 'claimed' ||
      existingClaim?.['status'] === 'launch_failed' ||
      existingBind?.['status'] === 'orphaned'
    ) {
      return { run: structuredClone(run), acquired: false }
    }

    const next: StoredRun = {
      ...run,
      metadata: {
        ...(run.metadata ?? {}),
        wrkfLaunchClaim: {
          status: 'claimed',
          claimId: input.claimId,
          idempotencyKey: input.idempotencyKey,
          wrkfRunId: input.wrkfRunId,
          claimedAt: input.claimedAt ?? new Date().toISOString(),
        },
      },
      updatedAt: new Date().toISOString(),
    }
    this.runs.set(input.runId, next)
    return { run: structuredClone(next), acquired: true }
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

    const definedPatch: DefinedRunPatch = {}
    assignDefined(definedPatch, patch, 'hrcRunId')
    assignDefined(definedPatch, patch, 'hostSessionId')
    assignDefined(definedPatch, patch, 'generation')
    assignDefined(definedPatch, patch, 'runtimeId')
    assignDefined(definedPatch, patch, 'transport')
    assignDefined(definedPatch, patch, 'metadata')
    assignDefined(definedPatch, patch, 'afterHrcSeq')

    const next: StoredRun = {
      ...run,
      ...('status' in patch ? { status: patch.status ?? run.status } : {}),
      ...definedPatch,
      updatedAt: new Date().toISOString(),
    }
    applyNullableStringPatch(next, patch, 'errorCode')
    applyNullableStringPatch(next, patch, 'errorMessage')

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

function assignDefined<Key extends keyof DefinedRunPatch>(
  target: DefinedRunPatch,
  patch: UpdateRunInput,
  key: Key
): void {
  if (key in patch) {
    const value = patch[key]
    if (value !== undefined) {
      Object.assign(target, { [key]: value })
    }
  }
}

function applyNullableStringPatch(
  target: StoredRun,
  patch: UpdateRunInput,
  key: 'errorCode' | 'errorMessage'
): void {
  if (!(key in patch)) {
    return
  }
  const value = patch[key]
  if (value === undefined) {
    return
  }
  if (value === null) {
    delete target[key]
    return
  }
  target[key] = value
}
