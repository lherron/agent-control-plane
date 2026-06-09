/**
 * POST /v1/pbc/tasks/:taskId/dispose — explicit human disposition (Phase 3).
 *
 * Disposition is an EXPLICIT human action only (agent role rejected). It records
 * a disposition_decision evidence BEFORE applying the legal dispose_from_<phase>
 * transition for the current phase, then delivers effects.
 *
 * Body carries form data only: { resolution, reason } — both required.
 */

import type { Actor } from 'acp-core'

import { badRequest, forbidden, json } from '../http.js'
import { parseJsonBody, requireRecord, requireTrimmedStringField } from '../parsers/body.js'
import type { RouteHandler } from '../routing/route-context.js'
import { applyFreshTransition } from '../wrkf/transition-apply.js'

import { buildPbcTaskProjection } from './projection.js'
import {
  deliverPbcEffects,
  mapPbcRouteError,
  readPbcEvidence,
  readPbcNext,
  requirePbcTaskId,
  requirePbcWrkf,
  wrkfActorString,
} from './shared.js'

export const handlePbcDispose: RouteHandler = async (context) => {
  const taskId = requirePbcTaskId(context.params)
  const wrkf = requirePbcWrkf(context.deps)

  const actor: Actor = context.actor ?? context.deps.defaultActor
  if (actor.kind !== 'human') {
    forbidden('actor_forbidden', 'disposition is an explicit human action only')
  }
  const actorString = wrkfActorString(actor)

  const body = requireRecord(await parseJsonBody(context.request))
  const resolution = requireTrimmedStringField(body, 'resolution')
  const reason = requireTrimmedStringField(body, 'reason')
  if (resolution.length === 0 || reason.length === 0) {
    badRequest('resolution and reason are required to dispose a PBC task')
  }

  try {
    const next = await readPbcNext(wrkf, taskId)
    const phase = next.instance.state.phase

    // disposition_decision evidence MUST be recorded before the transition.
    await wrkf.evidence.add({
      task: taskId,
      kind: 'disposition_decision',
      actor: actorString,
      role: 'product_owner',
      facts: { resolution, reason },
    })

    // Re-read wrkf.next AFTER the evidence write so the transition applies with
    // the FRESH revision/contextHash (the evidence.add bumps the wrkf context).
    // applyFreshTransition does the re-read + a single CAS retry on stale
    // revision/contextHash mismatch.
    await applyFreshTransition(wrkf, {
      task: taskId,
      transition: `dispose_from_${phase}`,
      role: 'product_owner',
      actor: actorString,
      routeKey: taskId,
      runChecks: false,
      assertLegal: false,
    })

    await deliverPbcEffects(wrkf, taskId)

    const after = await readPbcNext(wrkf, taskId)
    const evidence = await readPbcEvidence(wrkf, taskId)
    return json(buildPbcTaskProjection({ taskId, next: after, evidence }), 200)
  } catch (error) {
    throw mapPbcRouteError(error)
  }
}
