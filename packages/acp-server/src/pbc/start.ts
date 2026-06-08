/**
 * POST /v1/pbc/tasks/:taskId/start — install/reuse a PBC instance (Phase 3).
 *
 * Flow:
 *   1. Durable route idempotency by (route, taskId, actor, idempotencyKey, bodyHash).
 *   2. inspect-FIRST guard: never blindly re-attach. Reuse an existing active/waiting
 *      PBC instance; 409 on an active non-PBC instance or a closed PBC instance.
 *   3. Attach the PBC workflow only when no instance exists.
 *   4. Add intake_metadata evidence (idempotent within the route).
 *   5. normalize_feedback only when exactly legal (intake phase).
 *   6. Deliver effects; admit a continuation job unless waiting/terminal.
 *   7. Return PbcTaskProjection + job.
 */

import { AcpHttpError } from '../http.js'
import { isRecord } from '../parsers/body.js'
import type { RouteHandler } from '../routing/route-context.js'
import { withPbcRouteIdempotency } from '../handlers/wrkf-pbc-shared.js'
import type { AcpWrkfWorkflowPort } from '../wrkf/port.js'

import { buildPbcTaskProjection, PBC_WORKFLOW_REF } from './projection.js'
import {
  admitPbcContinuationJob,
  deliverPbcEffects,
  isAdmissibleForContinuation,
  readPbcNext,
  requirePbcStateStore,
  requirePbcTaskId,
  requirePbcWrkf,
  wrkfActorString,
} from './shared.js'

/**
 * The REAL wrkf binary THROWS WRKF_NOT_FOUND ("workflow instance not found")
 * when `task.inspect` runs on a task that was never attached to a workflow.
 * Treat that one case as "no instance yet" so start can fall through to attach.
 * A missing *task* (vs missing *instance*) or any other wrkf error must still
 * surface — so we require the message to mention the instance, not just NOT_FOUND.
 */
function isNoWorkflowInstanceError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  const code = (error as { code?: unknown }).code
  const message = error.message.toLowerCase()
  const isNotFound = code === 'WRKF_NOT_FOUND' || message.includes('not found')
  return isNotFound && message.includes('instance')
}

/**
 * Resolve the workflow instance from a `wrkf.task.inspect` result, handling BOTH
 * shapes:
 *   - NESTED ({ task, instance }) — used by older unit fakes; `inspected.instance`
 *     carries `workflowRef` + `state.status`.
 *   - FLAT (REAL @wrkf/client) — NO `task`/`instance` wrapper; the inspected record
 *     IS the instance: top-level `status`/`phase`/`revision` and `templateId` +
 *     `templateVersion` (see wrkf-real-inspect-shape.test.ts). The live closed-start
 *     bug (T-03072) was that the guard only looked at `inspected.instance`, missed
 *     the flat instance entirely, and silently re-attached → 200 on a closed task.
 *
 * The real binary THROWS WRKF_NOT_FOUND when no instance exists (swallowed by
 * isNoWorkflowInstanceError), so a successful flat inspect always means there IS
 * an instance — identified here by a top-level `templateId` or `status`. A bare
 * `{ task: {...} }` (no instance fields) is treated as "no instance" so a fresh
 * task still falls through to attach.
 */
function existingInstanceFrom(inspected: unknown): Record<string, unknown> | undefined {
  if (!isRecord(inspected)) {
    return undefined
  }
  const instance = inspected['instance']
  if (isRecord(instance)) {
    return instance
  }
  if (typeof inspected['templateId'] === 'string' || typeof inspected['status'] === 'string') {
    return inspected
  }
  return undefined
}

function instanceStatus(instance: Record<string, unknown>): string {
  const state = instance['state']
  if (isRecord(state) && typeof state['status'] === 'string') {
    return state['status']
  }
  return typeof instance['status'] === 'string' ? (instance['status'] as string) : 'unknown'
}

/**
 * Resolve the workflow ref from either shape:
 *   - NESTED fake: `instance.workflowRef` (already a full `name@version` ref).
 *   - FLAT real:   `${templateId}@${templateVersion}` (composed, matching how
 *     handleGetWorkflowTask builds workflowRef from the flat inspect keys).
 *   - next-style instance: nested `template.{id,version}`.
 * Returns undefined when none is present (treated as a non-PBC conflict).
 */
function instanceWorkflowRef(instance: Record<string, unknown>): string | undefined {
  if (typeof instance['workflowRef'] === 'string') {
    return instance['workflowRef']
  }
  const templateId = instance['templateId']
  if (typeof templateId === 'string') {
    const version = instance['templateVersion']
    return version === undefined ? templateId : `${templateId}@${String(version)}`
  }
  const template = instance['template']
  if (isRecord(template) && typeof template['id'] === 'string') {
    const version = template['version']
    return version === undefined ? template['id'] : `${template['id']}@${String(version)}`
  }
  return undefined
}

function instancePhase(instance: Record<string, unknown>): string {
  const state = instance['state']
  if (isRecord(state) && typeof state['phase'] === 'string') {
    return state['phase']
  }
  return typeof instance['phase'] === 'string' ? (instance['phase'] as string) : ''
}

async function maybeNormalizeFeedback(
  wrkf: AcpWrkfWorkflowPort,
  taskId: string,
  actor: string,
  next: Awaited<ReturnType<typeof readPbcNext>>
): Promise<Awaited<ReturnType<typeof readPbcNext>>> {
  const isIntake = next.instance.state.phase === 'intake'
  const normalize = next.actions.find((action) => action.transition === 'normalize_feedback')
  if (!isIntake || normalize === undefined) {
    return next
  }
  await wrkf.transition.apply({
    task: taskId,
    transition: 'normalize_feedback',
    role: 'agent',
    actor,
    expectRevision: next.instance.revision,
    contextHash: next.instance.contextHash ?? '',
    runChecks: false,
  })
  await deliverPbcEffects(wrkf, taskId)
  return readPbcNext(wrkf, taskId)
}

export const handlePbcStart: RouteHandler = (context) => {
  const taskId = requirePbcTaskId(context.params)
  const wrkf = requirePbcWrkf(context.deps)
  const stateStore = requirePbcStateStore(context.deps)
  const actor = wrkfActorString(context.actor ?? context.deps.defaultActor)

  return withPbcRouteIdempotency(
    context,
    `POST /v1/pbc/tasks/${taskId}/start`,
    async (body, idempotencyKey) => {
      // 1. inspect-FIRST: decide attach vs reuse vs conflict.
      //    The real wrkf binary throws WRKF_NOT_FOUND on a never-attached task,
      //    so guard the inspect call: swallow ONLY that "no instance" case and
      //    proceed to attach; rethrow everything else.
      let inspected: unknown
      try {
        inspected = await wrkf.task.inspect({ task: taskId })
      } catch (error) {
        if (!isNoWorkflowInstanceError(error)) {
          throw error
        }
        inspected = undefined
      }
      const existing = existingInstanceFrom(inspected)

      if (existing !== undefined) {
        const wfRef = instanceWorkflowRef(existing)
        const status = instanceStatus(existing)
        // Detect PBC by workflow NAME (templateId), not the version-pinned ref:
        // older PBC instances were attached at @1/@2/… and are still PBC. Matching
        // the exact PBC_WORKFLOW_REF (@5) would misclassify them as a conflict.
        const wfName = wfRef === undefined ? undefined : wfRef.split('@')[0]
        const pbcName = PBC_WORKFLOW_REF.split('@')[0]
        if (wfName === pbcName) {
          // Existing PBC instance: a closed/finalized one is terminal (no restart);
          // an active/waiting one is reused below (fall through to evidence/next).
          if (status === 'closed') {
            throw new AcpHttpError(
              409,
              'INSTANCE_CLOSED',
              `task ${taskId} has a closed PBC instance; restart is not supported`
            )
          }
        } else {
          // Any non-PBC instance (active OR closed) blocks a PBC start.
          throw new AcpHttpError(
            409,
            'INSTANCE_CONFLICT',
            `task ${taskId} has a non-PBC workflow instance (${wfRef ?? 'unknown'})`
          )
        }
      } else {
        await wrkf.task.attach({ task: taskId, workflow: PBC_WORKFLOW_REF })
      }

      // 4. intake_metadata evidence (idempotent within this route call).
      const intake = isRecord(body['intake']) ? (body['intake'] as Record<string, unknown>) : {}
      await wrkf.evidence.add({
        task: taskId,
        kind: 'intake_metadata',
        actor,
        role: 'agent',
        facts: intake,
      })

      // 5. normalize_feedback only when exactly legal.
      let next = await readPbcNext(wrkf, taskId)
      next = await maybeNormalizeFeedback(wrkf, taskId, actor, next)

      // 6. deliver effects + admit a continuation job unless waiting/terminal.
      await deliverPbcEffects(wrkf, taskId)
      const job = isAdmissibleForContinuation(next)
        ? admitPbcContinuationJob(stateStore, {
            taskId,
            revision: next.instance.revision,
            idempotencyKey,
          })
        : undefined

      const taskMeta = isRecord(inspected) ? inspected['task'] : undefined
      return buildPbcTaskProjection({ taskId, next, task: taskMeta, job })
    }
  )
}
