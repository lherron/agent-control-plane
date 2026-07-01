/**
 * adapter.ts — T-04784 Phase 2b.
 *
 * A THIN async adapter that maps `@wrkq/client` RPC (wrkq + wrkf namespaces)
 * onto the four acp-core store ports. This is the single mapping layer that
 * forwards wrkq/wrkf DTOs → acp-core DTOs.
 *
 * Daedalus ruling (T-04763 C-04677): this adapter is mapping GLUE ONLY. It does
 * NOT touch `.sqlite`, `runInTransaction`, `ActorResolver`,
 * `assertWrkqSchemaPresent`, nor the wrkq-lib error hierarchy. RPC failures
 * surface as the client's `WorkRpcError`; HTTP/CLI boundaries translate
 * `domainCode` → 404/409/422.
 *
 * Mapping table:
 *  - TaskStore.create/get/update  → wrkq.task.{create,show,update} (expectEtag CAS)
 *  - RoleAssignmentStore.get/set  → wrkf.role.list / wrkf.role.set (full-replace)
 *  - EvidenceStore.list/append    → wrkf.evidence.list / wrkf.evidence.add
 *  - TransitionLogStore.list      → wrkq.workflow.timeline, filtered to
 *                                   `workflow.transitioned` events
 *  - TransitionLogStore.append    → throws (not faithfully mappable; tests-only
 *                                   until P2d per daedalus ruling)
 *
 * projectId recovery: Task.projectId = container.show({ project: projectUuid }).id
 * (no SQL — pure @wrkq/client RPC).
 *
 * evidenceKinds in listTransitions: empty — not carried in the timeline event
 * payload. Callers needing evidence provenance query the EvidenceStore directly.
 */

import type {
  EvidenceItem,
  EvidenceStore,
  LoggedTransitionRecord,
  RoleAssignmentStore,
  RoleMap,
  Task,
  TaskLifecycleState,
  TaskStore,
  TransitionLogStore,
} from 'acp-core'

import { WorkRpcError } from '@wrkq/client'
import type {
  WorkClient,
  WrkfEvent,
  WrkfEvidence,
  WrkfEvidenceBuild,
  WrkfRoleBinding,
  WrkfState,
  WrkqTask,
  WrkqTaskKind,
  WrkqTaskState,
} from '@wrkq/client'

export interface WrkqStoreAdapter {
  readonly taskStore: TaskStore
  readonly evidenceStore: EvidenceStore
  readonly roleAssignmentStore: RoleAssignmentStore
  readonly transitionLogStore: TransitionLogStore
}

const TRANSITIONED_EVENT_TYPE = 'workflow.transitioned'

// ---------------------------------------------------------------------------
// Lifecycle-state <-> wrkq-task-state mapping.
//
// acp-core's `active` is wrkq's `in_progress`; every other state name matches
// 1:1. This mirrors the legacy SQLite mapping (mapping/task-row.ts) so the
// adapter is behaviour-equivalent at the lifecycle boundary.
// ---------------------------------------------------------------------------

function lifecycleToWrkqState(state: TaskLifecycleState): WrkqTaskState {
  return (state === 'active' ? 'in_progress' : state) as WrkqTaskState
}

function wrkqStateToLifecycle(state: WrkqTaskState): TaskLifecycleState {
  return state === 'in_progress' ? 'active' : state
}

// ---------------------------------------------------------------------------
// WrkfState accessors. The server returns `{ status, phase, outcome }` objects
// for transition payloads, but the type also permits a bare string.
// ---------------------------------------------------------------------------

function stateStatus(state: WrkfState | undefined): string | null {
  if (typeof state === 'string') {
    return state
  }
  if (state && typeof state.status === 'string') {
    return state.status
  }
  return null
}

function statePhase(state: WrkfState | undefined): string | null {
  if (state && typeof state === 'object' && typeof state.phase === 'string') {
    return state.phase
  }
  return null
}

// ---------------------------------------------------------------------------
// TaskStore
// ---------------------------------------------------------------------------

function createTaskStore(client: WorkClient): TaskStore {
  // Cache projectUuid → container id ("P-NNNNN"). Containers are immutable
  // enough for a single client session; this avoids a container.show RPC per
  // task read without reaching into SQL.
  const projectIdCache = new Map<string, string>()

  // acp-core's Task has no title field, but wrkq requires a unique
  // (project, slug) — and slug is derived from title. The advisory input
  // taskId may repeat across calls, so synthesize a per-adapter monotonic
  // suffix to keep created tasks distinct. (createTask has no production
  // caller; this only matters for the parity/contract suites.)
  let createSeq = 0

  async function recoverProjectId(projectUuid: string): Promise<string> {
    const cached = projectIdCache.get(projectUuid)
    if (cached !== undefined) {
      return cached
    }
    const container = await client.wrkq.container.show({ project: projectUuid })
    projectIdCache.set(projectUuid, container.id)
    return container.id
  }

  async function toTask(wrkqTask: WrkqTask): Promise<Task> {
    const projectId = await recoverProjectId(wrkqTask.projectUuid)
    return {
      taskId: wrkqTask.id,
      projectId,
      kind: wrkqTask.kind,
      lifecycleState: wrkqStateToLifecycle(wrkqTask.state),
      // wrkq tasks no longer carry an acp phase column; the workflow phase lives
      // in the attached wrkf instance, surfaced via the transition log.
      phase: null,
      ...(wrkqTask.riskClass !== undefined ? { riskClass: wrkqTask.riskClass } : {}),
      roleMap: {},
      version: wrkqTask.etag,
    }
  }

  return {
    async createTask(task: Task): Promise<Task> {
      // Strip legacy phase/workflowPreset/presetVersion — wrkq.task.create has
      // no such params, and wrkq.task.update now rejects them.
      const created = await client.wrkq.task.create({
        project: task.projectId,
        title: `${task.taskId}-${createSeq++}`,
        kind: task.kind as WrkqTaskKind,
        state: lifecycleToWrkqState(task.lifecycleState),
        ...(task.riskClass !== undefined ? { riskClass: task.riskClass } : {}),
      })
      return toTask(created)
    },

    async getTask(taskId: string): Promise<Task | undefined> {
      try {
        const wrkqTask = await client.wrkq.task.show({ task: taskId })
        return await toTask(wrkqTask)
      } catch (error) {
        if (error instanceof WorkRpcError && error.domainCode === 'WRKQ_NOT_FOUND') {
          return undefined
        }
        throw error
      }
    },

    async updateTask(task: Task): Promise<Task> {
      // expectEtag enforces CAS: a stale Task.version surfaces WRKQ_CONFLICT.
      // Legacy phase/workflowPreset/presetVersion are intentionally omitted.
      const updated = await client.wrkq.task.update({
        task: task.taskId,
        patch: {
          state: lifecycleToWrkqState(task.lifecycleState),
          ...(task.riskClass !== undefined ? { riskClass: task.riskClass } : {}),
        },
        expectEtag: task.version,
      })
      return toTask(updated)
    },
  }
}

// ---------------------------------------------------------------------------
// RoleAssignmentStore
// ---------------------------------------------------------------------------

function createRoleAssignmentStore(client: WorkClient): RoleAssignmentStore {
  return {
    async getRoleMap(taskId: string): Promise<RoleMap> {
      // wrkf.role.list returns null (not []) when the instance has no bindings.
      const bindings: WrkfRoleBinding[] = (await client.wrkf.role.list({ task: taskId })) ?? []
      const roleMap: Record<string, string> = {}
      for (const binding of bindings) {
        roleMap[binding.role] = binding.principal_ref
      }
      return roleMap
    },

    async setRoleMap(taskId: string, roleMap: RoleMap): Promise<void> {
      // Full-replace; no client-side diff (daedalus ruling).
      await client.wrkf.role.set({ task: taskId, roleMap: { ...roleMap } })
    },
  }
}

// ---------------------------------------------------------------------------
// EvidenceStore
// ---------------------------------------------------------------------------

function toWrkfBuild(build: EvidenceItem['build']): WrkfEvidenceBuild | undefined {
  if (build === undefined) {
    return undefined
  }
  return {
    ...(build.id !== undefined ? { id: build.id } : {}),
    ...(build.version !== undefined ? { version: build.version } : {}),
    ...(build.env !== undefined ? { env: build.env } : {}),
  }
}

function toEvidenceItem(evidence: WrkfEvidence): EvidenceItem {
  const item: EvidenceItem = {
    kind: evidence.kind ?? '',
    ref: evidence.ref ?? '',
  }
  if (evidence.contentHash !== undefined) {
    item.contentHash = evidence.contentHash
  }
  if (evidence.principal_ref !== undefined) {
    item.producedBy = {
      agentId: evidence.principal_ref,
      ...(evidence.role !== undefined ? { role: evidence.role } : {}),
    }
  }
  if (evidence.producedAt !== undefined) {
    item.timestamp = evidence.producedAt
  }
  if (evidence.build !== undefined) {
    item.build = {
      ...(evidence.build.id !== undefined ? { id: evidence.build.id } : {}),
      ...(evidence.build.version !== undefined ? { version: evidence.build.version } : {}),
      ...(evidence.build.env !== undefined ? { env: evidence.build.env } : {}),
    }
  }
  return item
}

function createEvidenceStore(client: WorkClient): EvidenceStore {
  return {
    async listEvidence(taskId: string): Promise<readonly EvidenceItem[]> {
      // wrkf.evidence.list returns null (not []) when there is no evidence.
      const evidence: WrkfEvidence[] = (await client.wrkf.evidence.list({ task: taskId })) ?? []
      return evidence.map(toEvidenceItem)
    },

    async appendEvidence(taskId: string, evidence: readonly EvidenceItem[]): Promise<void> {
      for (const item of evidence) {
        const build = toWrkfBuild(item.build)
        await client.wrkf.evidence.add({
          task: taskId,
          kind: item.kind,
          ...(item.ref !== undefined ? { ref: item.ref } : {}),
          ...(item.producedBy?.agentId !== undefined
            ? { principal_ref: item.producedBy.agentId }
            : {}),
          ...(item.producedBy?.role !== undefined ? { role: item.producedBy.role } : {}),
          ...(item.contentHash !== undefined ? { contentHash: item.contentHash } : {}),
          ...(build !== undefined ? { build } : {}),
        })
      }
    },
  }
}

// ---------------------------------------------------------------------------
// TransitionLogStore
// ---------------------------------------------------------------------------

function toLoggedTransition(taskId: string, event: WrkfEvent): LoggedTransitionRecord {
  const payload = event.payload ?? {}
  const observedRevision =
    typeof event['observedRevision'] === 'number' ? (event['observedRevision'] as number) : 0
  const nextRevision =
    typeof event['nextRevision'] === 'number' ? (event['nextRevision'] as number) : observedRevision
  const actorId =
    typeof event['principal_ref'] === 'string' ? (event['principal_ref'] as string) : ''
  const role = typeof event['role'] === 'string' ? (event['role'] as string) : ''
  const createdAt = typeof event['createdAt'] === 'string' ? (event['createdAt'] as string) : ''

  return {
    taskId,
    transitionEventId: event.id,
    timestamp: createdAt,
    from: {
      lifecycleState: stateStatus(payload.from) ?? '',
      phase: statePhase(payload.from),
    },
    to: {
      lifecycleState: stateStatus(payload.to) ?? '',
      phase: statePhase(payload.to),
    },
    actor: { agentId: actorId, role },
    // KNOWN LIMITATION: timeline events do not carry evidence-kind arrays.
    // No production reader consumes these; callers needing provenance query the
    // EvidenceStore directly.
    requiredEvidenceKinds: [],
    evidenceKinds: [],
    waivedEvidenceKinds: [],
    expectedVersion: observedRevision,
    nextVersion: nextRevision,
  }
}

function createTransitionLogStore(client: WorkClient): TransitionLogStore {
  return {
    async listTransitions(taskId: string): Promise<readonly LoggedTransitionRecord[]> {
      const timeline = await client.wrkq.workflow.timeline({ task: taskId })
      return timeline.events
        .filter((event) => event.type === TRANSITIONED_EVENT_TYPE)
        .map((event) => toLoggedTransition(taskId, event))
    },

    async appendTransition(_taskId: string, _transition: LoggedTransitionRecord): Promise<void> {
      // Not faithfully mappable to wrkf.transition.apply: apply cannot preserve a
      // caller-specified transitionEventId, timestamp, or version. Per daedalus
      // (T-04763 C-04677) we do NOT lie about preservation — this port method is
      // tests-only and throws until removed in P2d.
      throw new Error(
        'appendTransition is not supported by the @wrkq/client adapter: ' +
          'wrkf.transition.apply cannot preserve raw id/timestamp/version. ' +
          'Use wrkf.transition.apply to drive a real transition instead.'
      )
    },
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build the four acp-core store ports from a single shared `WorkClient`. The
 * Phase-1 lifecycle (acp-server src/wrkf/client-lifecycle.ts) owns one client
 * and derives BOTH the wrkf port adapter AND this store adapter from it.
 */
export function createWrkqStoreAdapter(client: WorkClient): WrkqStoreAdapter {
  return {
    taskStore: createTaskStore(client),
    evidenceStore: createEvidenceStore(client),
    roleAssignmentStore: createRoleAssignmentStore(client),
    transitionLogStore: createTransitionLogStore(client),
  }
}
