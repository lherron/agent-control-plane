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

function existingInstanceFrom(inspected: unknown): Record<string, unknown> | undefined {
  if (!isRecord(inspected)) {
    return undefined
  }
  const instance = inspected['instance']
  return isRecord(instance) ? instance : undefined
}

function instanceStatus(instance: Record<string, unknown>): string {
  const state = instance['state']
  if (isRecord(state) && typeof state['status'] === 'string') {
    return state['status']
  }
  return typeof instance['status'] === 'string' ? (instance['status'] as string) : 'unknown'
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
      const inspected = await wrkf.task.inspect({ task: taskId })
      const existing = existingInstanceFrom(inspected)

      if (existing !== undefined) {
        const wfRef = typeof existing['workflowRef'] === 'string' ? existing['workflowRef'] : undefined
        const status = instanceStatus(existing)
        if (wfRef !== PBC_WORKFLOW_REF) {
          throw new AcpHttpError(
            409,
            'INSTANCE_CONFLICT',
            `task ${taskId} has an active non-PBC workflow instance`
          )
        }
        if (status === 'closed') {
          throw new AcpHttpError(
            409,
            'INSTANCE_CLOSED',
            `task ${taskId} has a closed PBC instance; restart is not supported`
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
