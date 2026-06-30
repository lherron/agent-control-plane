import type { Actor } from 'acp-core'
import type { SessionRef } from 'agent-scope'

import type {
  AcquireLaunchClaimInput,
  AcquireLaunchClaimResult,
  CreateOrGetRunInput,
  CreateOrGetRunResult,
  DispatchFence,
  StoredRun,
  UpdateRunInput,
} from '../types.js'
import { RunCorrelationConflictError } from '../types.js'
import type { RepoContext } from './shared.js'
import { DEFAULT_SYSTEM_ACTOR, parseJsonRecord, shortId } from './shared.js'

export { RunCorrelationConflictError } from '../types.js'

/**
 * Derive a deterministic, stable ACP run id from a wrkf run id.
 * Pure and side-effect-free: the wrkfRunId is embedded verbatim so it is
 * recoverable from the ACP runId for traceability.
 */
export function deriveRunId(wrkfRunId: string): string {
  return `run_wrkf_${wrkfRunId}`
}

/** Conflict fields compared on replay. wrkfInstanceId is intentionally excluded. */
const RUN_CORRELATION_CONFLICT_FIELDS = ['wrkfTaskId', 'wrkfRunId', 'workflowRef', 'role'] as const

/**
 * `updateRun` patch keys that map 1:1 onto {@link StoredRun} and follow the
 * uniform "apply iff present-and-defined" rule. `status` is handled separately
 * because absence/undefined falls back to the current status rather than no-op.
 */
const RUN_PATCH_PASSTHROUGH_KEYS = [
  'hrcRunId',
  'hostSessionId',
  'generation',
  'runtimeId',
  'transport',
  'metadata',
  'afterHrcSeq',
] as const satisfies readonly (keyof UpdateRunInput & keyof StoredRun)[]

/**
 * Build the partial overlay for the passthrough keys, preserving the original
 * ladder's semantics exactly: a key absent from `patch` is left untouched, a
 * key present but `undefined` is a no-op (NOT a clear), and a key present with a
 * value is applied.
 */
function applyDefinedRunPatch(patch: UpdateRunInput): Partial<StoredRun> {
  const overlay: Partial<StoredRun> = {}
  for (const key of RUN_PATCH_PASSTHROUGH_KEYS) {
    if (key in patch) {
      const value = patch[key]
      if (value !== undefined) {
        // Same-named, same-typed keys on both sides; the per-key narrowing is
        // erased by the loop, so a single assignment cast is required here.
        ;(overlay as Record<string, unknown>)[key] = value
      }
    }
  }
  return overlay
}

function assertRunCorrelationMatches(
  runId: string,
  existing: Record<string, unknown> | undefined,
  input: CreateOrGetRunInput
): void {
  const metadata = existing ?? {}
  for (const field of RUN_CORRELATION_CONFLICT_FIELDS) {
    const expected = metadata[field]
    const actual = input[field]
    if (expected !== actual) {
      throw new RunCorrelationConflictError({ runId, field, expected, actual })
    }
  }
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

type RunRow = {
  run_id: string
  scope_ref: string
  lane_ref: string
  task_id: string | null
  actor_kind: Actor['kind']
  actor_id: string
  actor_display_name: string | null
  status: StoredRun['status']
  hrc_run_id: string | null
  host_session_id: string | null
  generation: number | null
  runtime_id: string | null
  transport: string | null
  error_code: string | null
  error_message: string | null
  dispatch_fence_json: string | null
  expected_host_session_id: string | null
  expected_generation: number | null
  follow_latest: number | null
  after_hrc_seq: number | null
  metadata_json: string | null
  created_at: string
  updated_at: string
}

const RUN_SELECT_SQL = `SELECT run_id,
                scope_ref,
                lane_ref,
                task_id,
                actor_kind,
                actor_id,
                actor_display_name,
                status,
                hrc_run_id,
                host_session_id,
                generation,
                runtime_id,
                transport,
                error_code,
                error_message,
                dispatch_fence_json,
                expected_host_session_id,
                expected_generation,
                follow_latest,
                after_hrc_seq,
                metadata_json,
                created_at,
                updated_at
           FROM runs`

function mapDispatchFence(row: RunRow): DispatchFence | undefined {
  if (row.dispatch_fence_json !== null) {
    return JSON.parse(row.dispatch_fence_json) as DispatchFence
  }

  if (
    row.expected_host_session_id === null &&
    row.expected_generation === null &&
    row.follow_latest === null
  ) {
    return undefined
  }

  return {
    ...(row.expected_host_session_id !== null
      ? { expectedHostSessionId: row.expected_host_session_id }
      : {}),
    ...(row.expected_generation !== null ? { expectedGeneration: row.expected_generation } : {}),
    ...(row.follow_latest !== null ? { followLatest: row.follow_latest !== 0 } : {}),
  }
}

function mapRunRow(row: RunRow): StoredRun {
  const dispatchFence = mapDispatchFence(row)
  const metadata = parseJsonRecord(row.metadata_json)

  return {
    runId: row.run_id,
    scopeRef: row.scope_ref,
    laneRef: row.lane_ref,
    ...(row.task_id !== null ? { taskId: row.task_id } : {}),
    actor: {
      kind: row.actor_kind,
      id: row.actor_id,
      ...(row.actor_display_name !== null ? { displayName: row.actor_display_name } : {}),
    },
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.hrc_run_id !== null ? { hrcRunId: row.hrc_run_id } : {}),
    ...(row.host_session_id !== null ? { hostSessionId: row.host_session_id } : {}),
    ...(row.generation !== null ? { generation: row.generation } : {}),
    ...(row.runtime_id !== null ? { runtimeId: row.runtime_id } : {}),
    ...(row.transport !== null ? { transport: row.transport } : {}),
    ...(row.error_code !== null ? { errorCode: row.error_code } : {}),
    ...(row.error_message !== null ? { errorMessage: row.error_message } : {}),
    ...(dispatchFence !== undefined ? { dispatchFence } : {}),
    ...(row.after_hrc_seq !== null ? { afterHrcSeq: row.after_hrc_seq } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  }
}

type PersistedRun = {
  runId: string
  scopeRef: string
  laneRef: string
  taskId: string | null
  actorKind: Actor['kind']
  actorId: string
  actorDisplayName: string | null
  status: StoredRun['status']
  hrcRunId: string | null
  hostSessionId: string | null
  generation: number | null
  runtimeId: string | null
  transport: string | null
  errorCode: string | null
  errorMessage: string | null
  dispatchFenceJson: string | null
  expectedHostSessionId: string | null
  expectedGeneration: number | null
  followLatest: number | null
  afterHrcSeq: number | null
  metadataJson: string | null
  createdAt: string
  updatedAt: string
}

function toPersistedRun(run: StoredRun): PersistedRun {
  return {
    runId: run.runId,
    scopeRef: run.scopeRef,
    laneRef: run.laneRef,
    taskId: run.taskId ?? null,
    actorKind: run.actor.kind,
    actorId: run.actor.id,
    actorDisplayName: run.actor.displayName ?? null,
    status: run.status,
    hrcRunId: run.hrcRunId ?? null,
    hostSessionId: run.hostSessionId ?? null,
    generation: run.generation ?? null,
    runtimeId: run.runtimeId ?? null,
    transport: run.transport ?? null,
    errorCode: run.errorCode ?? null,
    errorMessage: run.errorMessage ?? null,
    dispatchFenceJson: run.dispatchFence === undefined ? null : JSON.stringify(run.dispatchFence),
    expectedHostSessionId: run.dispatchFence?.expectedHostSessionId ?? null,
    expectedGeneration: run.dispatchFence?.expectedGeneration ?? null,
    followLatest:
      run.dispatchFence?.followLatest === undefined ? null : run.dispatchFence.followLatest ? 1 : 0,
    afterHrcSeq: run.afterHrcSeq ?? null,
    metadataJson: run.metadata === undefined ? null : JSON.stringify(run.metadata),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  }
}

export class RunRepo {
  constructor(private readonly context: RepoContext) {}

  createRun(input: {
    sessionRef: SessionRef
    taskId?: string | undefined
    actor?: Actor | undefined
    status?: StoredRun['status'] | undefined
    metadata?: Readonly<Record<string, unknown>> | undefined
  }): StoredRun {
    const actor = input.actor ?? DEFAULT_SYSTEM_ACTOR
    const timestamp = new Date().toISOString()
    const run: StoredRun = {
      runId: shortId('run_'),
      scopeRef: input.sessionRef.scopeRef,
      laneRef: input.sessionRef.laneRef,
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      actor,
      status: input.status ?? 'pending',
      createdAt: timestamp,
      updatedAt: timestamp,
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    }

    this.insert(run)

    return this.require(run.runId)
  }

  private insert(run: StoredRun): void {
    const persisted = toPersistedRun(run)
    this.context.sqlite
      .prepare(
        `INSERT INTO runs (
           run_id,
           scope_ref,
           lane_ref,
           task_id,
           actor_kind,
           actor_id,
           actor_display_name,
           status,
           hrc_run_id,
           host_session_id,
           generation,
           runtime_id,
           transport,
           error_code,
           error_message,
           dispatch_fence_json,
           expected_host_session_id,
           expected_generation,
           follow_latest,
           after_hrc_seq,
           metadata_json,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        persisted.runId,
        persisted.scopeRef,
        persisted.laneRef,
        persisted.taskId,
        persisted.actorKind,
        persisted.actorId,
        persisted.actorDisplayName,
        persisted.status,
        persisted.hrcRunId,
        persisted.hostSessionId,
        persisted.generation,
        persisted.runtimeId,
        persisted.transport,
        persisted.errorCode,
        persisted.errorMessage,
        persisted.dispatchFenceJson,
        persisted.expectedHostSessionId,
        persisted.expectedGeneration,
        persisted.followLatest,
        persisted.afterHrcSeq,
        persisted.metadataJson,
        persisted.createdAt,
        persisted.updatedAt
      )
  }

  /**
   * Idempotently create (or replay) a wrkf-correlated run keyed on a
   * deterministic id derived from the wrkf run id. NON-CANONICAL: this record
   * is telemetry / dispatch-fencing only — wrkf.run.bindExternal remains
   * execution truth.
   *
   * Semantics:
   *   - no existing row       → insert, return { run, created: true }
   *   - existing + match       → replay, return { run, created: false }
   *   - existing + conflict    → throw RunCorrelationConflictError
   * Conflict fields: wrkfTaskId, wrkfRunId, workflowRef, role
   * (wrkfInstanceId may rotate for the same run and is NOT a conflict.)
   */
  createOrGetRun(input: CreateOrGetRunInput): CreateOrGetRunResult {
    return this.context.sqlite.transaction(() => {
      const runId = deriveRunId(input.wrkfRunId)
      const existing = this.getRun(runId)
      if (existing !== undefined) {
        assertRunCorrelationMatches(runId, existing.metadata, input)
        return { run: existing, created: false }
      }

      const actor = input.actor ?? DEFAULT_SYSTEM_ACTOR
      const timestamp = new Date().toISOString()
      const metadata: Record<string, unknown> = {
        source: 'wrkf',
        wrkfTaskId: input.wrkfTaskId,
        wrkfInstanceId: input.wrkfInstanceId,
        wrkfRunId: input.wrkfRunId,
        workflowRef: input.workflowRef,
        role: input.role,
      }
      const run: StoredRun = {
        runId,
        scopeRef: input.sessionRef.scopeRef,
        laneRef: input.sessionRef.laneRef,
        actor,
        status: input.status ?? 'pending',
        createdAt: timestamp,
        updatedAt: timestamp,
        metadata,
      }

      this.insert(run)
      return { run: this.require(runId), created: true }
    })()
  }

  acquireLaunchClaim(input: AcquireLaunchClaimInput): AcquireLaunchClaimResult {
    return this.context.sqlite.transaction(() => {
      const current = this.require(input.runId)
      const existingClaim = readRecord(current.metadata?.['wrkfLaunchClaim'])
      const existingBind = readRecord(current.metadata?.['wrkfExternalBind'])
      if (
        current.hrcRunId !== undefined ||
        existingClaim?.['status'] === 'claimed' ||
        existingClaim?.['status'] === 'launch_failed' ||
        existingBind?.['status'] === 'orphaned'
      ) {
        return { run: current, acquired: false }
      }

      const next: StoredRun = {
        ...current,
        metadata: {
          ...(current.metadata ?? {}),
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
      this.persist(next)
      return { run: this.require(input.runId), acquired: true }
    })()
  }

  getRun(runId: string): StoredRun | undefined {
    const row = this.context.sqlite
      .prepare(
        `${RUN_SELECT_SQL}
          WHERE run_id = ?`
      )
      .get(runId) as RunRow | undefined

    return row === undefined ? undefined : mapRunRow(row)
  }

  listRuns(): readonly StoredRun[] {
    const rows = this.context.sqlite
      .prepare(
        `${RUN_SELECT_SQL}
       ORDER BY created_at ASC, run_id ASC`
      )
      .all() as RunRow[]

    return rows.map((row) => mapRunRow(row))
  }

  listRunsByStatus(status: string): readonly StoredRun[] {
    const rows = this.context.sqlite
      .prepare(
        `${RUN_SELECT_SQL}
          WHERE status = ?
       ORDER BY created_at ASC, run_id ASC`
      )
      .all(status) as RunRow[]

    return rows.map((row) => mapRunRow(row))
  }

  listRunsForSession(sessionRef: SessionRef): readonly StoredRun[] {
    const rows = this.context.sqlite
      .prepare(
        `${RUN_SELECT_SQL}
          WHERE scope_ref = ?
            AND lane_ref = ?
       ORDER BY created_at ASC, run_id ASC`
      )
      .all(sessionRef.scopeRef, sessionRef.laneRef) as RunRow[]

    return rows.map((row) => mapRunRow(row))
  }

  updateRun(runId: string, patch: UpdateRunInput): StoredRun {
    return this.context.sqlite.transaction(() => {
      const current = this.require(runId)
      const next: StoredRun = {
        ...current,
        ...('status' in patch ? { status: patch.status ?? current.status } : {}),
        ...applyDefinedRunPatch(patch),
        updatedAt: new Date().toISOString(),
      }
      applyNullableStringPatch(next, patch, 'errorCode')
      applyNullableStringPatch(next, patch, 'errorMessage')

      this.persist(next)
      return this.require(runId)
    })()
  }

  setDispatchFence(runId: string, dispatchFence: DispatchFence): StoredRun {
    return this.context.sqlite.transaction(() => {
      const current = this.require(runId)
      const next: StoredRun = {
        ...current,
        dispatchFence,
        updatedAt: new Date().toISOString(),
      }

      this.persist(next)
      return this.require(runId)
    })()
  }

  private persist(run: StoredRun): void {
    const persisted = toPersistedRun(run)
    this.context.sqlite
      .prepare(
        `UPDATE runs
            SET scope_ref = ?,
                lane_ref = ?,
                task_id = ?,
                status = ?,
                hrc_run_id = ?,
                host_session_id = ?,
                generation = ?,
                runtime_id = ?,
                transport = ?,
                error_code = ?,
                error_message = ?,
                dispatch_fence_json = ?,
                expected_host_session_id = ?,
                expected_generation = ?,
                follow_latest = ?,
                after_hrc_seq = ?,
                metadata_json = ?,
                updated_at = ?
          WHERE run_id = ?`
      )
      .run(
        persisted.scopeRef,
        persisted.laneRef,
        persisted.taskId,
        persisted.status,
        persisted.hrcRunId,
        persisted.hostSessionId,
        persisted.generation,
        persisted.runtimeId,
        persisted.transport,
        persisted.errorCode,
        persisted.errorMessage,
        persisted.dispatchFenceJson,
        persisted.expectedHostSessionId,
        persisted.expectedGeneration,
        persisted.followLatest,
        persisted.afterHrcSeq,
        persisted.metadataJson,
        persisted.updatedAt,
        persisted.runId
      )
  }

  private require(runId: string): StoredRun {
    const run = this.getRun(runId)
    if (run === undefined) {
      throw new Error(`run not found: ${runId}`)
    }

    return run
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
