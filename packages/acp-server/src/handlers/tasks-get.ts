import { json } from '../http.js'
import { maybeComputeTaskContext, requireTask, requireTaskId } from './shared.js'

import type { RouteHandler } from '../routing/route-context.js'

export const handleGetTask: RouteHandler = ({ request, url, params, deps }) => {
  const taskId = requireTaskId(params)
  const task = requireTask(deps.wrkqStore.taskRepo.getTask(taskId), taskId)
  const role = url.searchParams.get('role')?.trim() || undefined
  const context = maybeComputeTaskContext({
    task,
    request,
    roleFromQuery: role,
    getPreset: deps.presetRegistry.getPreset.bind(deps.presetRegistry),
  })

  return json({
    task,
    ...(context !== undefined ? { context } : {}),
  })
}
