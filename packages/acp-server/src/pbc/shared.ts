/**
 * Shared helpers for the /v1/pbc/* product facade (Phase 3, T-02864).
 *
 * These wrap the generic wrkf runtime with requiredPack:'pbc' +
 * requiredWorkflowRef:'pbc-progressive-refinement@5'. The product routes never
 * accept raw transition IDs / contextHash / obligation wire shapes as required
 * mutation inputs — body carries form data only; the server decides authority.
 */

import type { Actor } from 'acp-core'
import type { AcpStateStore, PbcContinuationJob } from 'acp-state-store'

import { AcpHttpError } from '../http.js'
import type { RouteContext } from '../routing/route-context.js'
import { deliverWrkfEffects } from '../wrkf/effect-delivery.js'
import { wrkfErrorToHttpStatus } from '../wrkf/errors.js'
import type { AcpWrkfWorkflowPort } from '../wrkf/port.js'
import { projectNextActionResponse, type NextActionResponse } from '../wrkf/projections.js'

import { PBC_WORKFLOW_REF } from './projection.js'

/** wrkf actor wire form (`kind:id`) from a parsed Actor. */
export function wrkfActorString(actor: Actor): string {
  return `${actor.kind}:${actor.id}`
}

export function requirePbcTaskId(params: Record<string, string | undefined>): string {
  const taskId = params['taskId']
  if (taskId === undefined || taskId.length === 0) {
    throw new AcpHttpError(400, 'malformed_request', 'taskId route parameter is required')
  }
  return taskId
}

export function requirePbcWrkf(deps: RouteContext['deps']): AcpWrkfWorkflowPort {
  const wrkf = deps.wrkf
  if (wrkf === undefined) {
    throw new AcpHttpError(503, 'WRKF_UNAVAILABLE', 'wrkf port not available')
  }
  return wrkf
}

export function requirePbcStateStore(deps: RouteContext['deps']): AcpStateStore {
  const stateStore = deps.stateStore
  if (stateStore === undefined) {
    throw new AcpHttpError(503, 'STATE_STORE_UNAVAILABLE', 'state store not available')
  }
  return stateStore
}

/** Map a thrown wrkf error to an AcpHttpError; pass others through untouched. */
export function mapPbcRouteError(error: unknown): unknown {
  if (error instanceof AcpHttpError) {
    return error
  }
  if (isWrkfError(error)) {
    return new AcpHttpError(wrkfErrorToHttpStatus(error.code), error.code, error.message)
  }
  return error
}

function isWrkfError(error: unknown): error is Error & { code: string } {
  const candidate = error as { code?: unknown }
  return error instanceof Error && typeof candidate.code === 'string' && candidate.code.length > 0
}

/** Read the live `next` projection for the PBC agent role. */
export async function readPbcNext(
  wrkf: AcpWrkfWorkflowPort,
  taskId: string
): Promise<NextActionResponse> {
  return projectNextActionResponse(await wrkf.next({ task: taskId, role: 'agent' }))
}

/** A workflow instance is admissible for a continuation job only when active. */
export function isAdmissibleForContinuation(next: NextActionResponse): boolean {
  return next.instance.state.status === 'active'
}

/** Admit (or replay) a durable PBC continuation job. NO inline HRC work here. */
export function admitPbcContinuationJob(
  stateStore: AcpStateStore,
  input: { taskId: string; revision: number; idempotencyKey: string }
): PbcContinuationJob {
  const { job } = stateStore.pbcContinuationJobs.admit({
    taskId: input.taskId,
    workflowRef: PBC_WORKFLOW_REF,
    revisionAtAdmission: String(input.revision),
    idempotencyKey: input.idempotencyKey,
  })
  return job
}

/** Deliver any pending wrkf effects for the task (no-op when none pending). */
export async function deliverPbcEffects(
  wrkf: AcpWrkfWorkflowPort,
  taskId: string
): Promise<void> {
  await deliverWrkfEffects(wrkf, { task: taskId })
}
