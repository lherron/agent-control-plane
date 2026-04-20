import { json } from '../http.js'
import { requireTask, requireTaskId } from './shared.js'

import type { RouteHandler } from '../routing/route-context.js'

export const handleListTaskTransitions: RouteHandler = ({ params, deps }) => {
  const taskId = requireTaskId(params)
  requireTask(deps.wrkqStore.taskRepo.getTask(taskId), taskId)
  return json({
    transitions: deps.wrkqStore.transitionLogRepo.listTransitions(taskId),
  })
}
