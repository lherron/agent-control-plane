import { randomUUID } from 'node:crypto'

import type { Actor } from 'acp-core'
import type { SessionRef } from 'agent-scope'

import type { DispatchFence, StoredRun, UpdateRunInput } from '../types.js'
import type { RepoContext } from './shared.js'
import { parseJsonRecord } from './shared.js'

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
  metadata_json: string | null
  created_at: string
  updated_at: string
}

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
    metadata?: Readonly<Record<string, unknown>> | undefined
  }): StoredRun {
    const actor = input.actor ?? { kind: 'system', id: 'acp-local' }
    const timestamp = new Date().toISOString()
    const run: StoredRun = {
      runId: `run_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      scopeRef: input.sessionRef.scopeRef,
      laneRef: input.sessionRef.laneRef,
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      actor,
      status: 'pending',
      createdAt: timestamp,
      updatedAt: timestamp,
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    }

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
           metadata_json,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        persisted.metadataJson,
        persisted.createdAt,
        persisted.updatedAt
      )

    return this.require(run.runId)
  }

  getRun(runId: string): StoredRun | undefined {
    const row = this.context.sqlite
      .prepare(
        `SELECT run_id,
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
                metadata_json,
                created_at,
                updated_at
           FROM runs
          WHERE run_id = ?`
      )
      .get(runId) as RunRow | undefined

    return row === undefined ? undefined : mapRunRow(row)
  }

  listRuns(): readonly StoredRun[] {
    const rows = this.context.sqlite
      .prepare(
        `SELECT run_id,
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
                metadata_json,
                created_at,
                updated_at
           FROM runs
       ORDER BY created_at ASC, run_id ASC`
      )
      .all() as RunRow[]

    return rows.map((row) => mapRunRow(row))
  }

  listRunsForSession(sessionRef: SessionRef): readonly StoredRun[] {
    const rows = this.context.sqlite
      .prepare(
        `SELECT run_id,
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
                metadata_json,
                created_at,
                updated_at
           FROM runs
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
