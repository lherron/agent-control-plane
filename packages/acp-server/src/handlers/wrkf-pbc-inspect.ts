import { json } from '../http.js'
import type { RouteHandler } from '../routing/route-context.js'
import { PBC_WORKFLOW_TEMPLATE_REF } from '../wrkf/packs/pbc/template-model.js'
import { projectNextActionResponse } from '../wrkf/projections.js'

import { mapPbcRouteError, requirePbcTaskParam, requireWrkf } from './wrkf-pbc-shared.js'

const WORKFLOW_REF = PBC_WORKFLOW_TEMPLATE_REF

export const handleWrkfPbcInspect: RouteHandler = async ({ params, deps }) => {
  const task = requirePbcTaskParam(params)
  const wrkf = requireWrkf(deps)

  try {
    const projected = projectNextActionResponse(await wrkf.next({ task, role: 'agent' }))
    return json({
      task,
      workflowRef: WORKFLOW_REF,
      instance: {
        status: projected.instance.state.status,
        phase: projected.instance.state.phase,
        revision: projected.instance.revision,
        contextHash: projected.instance.contextHash ?? '',
        ...(projected.instance.stale !== undefined ? { stale: projected.instance.stale } : {}),
      },
      next: {
        actions: projected.actions,
        blockedTransitions: projected.blockedTransitions,
        openObligations: projected.openObligations,
        pendingEffects: projected.pendingEffects,
      },
    })
  } catch (error) {
    throw mapPbcRouteError(error)
  }
}
