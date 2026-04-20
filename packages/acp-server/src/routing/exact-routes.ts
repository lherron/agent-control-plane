import { handleCreateInput } from '../handlers/inputs.js'
import { handleCreateMessage } from '../handlers/messages.js'
import { handleResolveRuntime } from '../handlers/runtime-resolve.js'
import { handleResolveSession } from '../handlers/sessions-resolve.js'
import { handleCreateTask } from '../handlers/tasks-create.js'
import { handleLaunchSession } from '../launch-role-scoped.js'

import type { ResolvedAcpServerDeps } from '../deps.js'
import type { RouteHandler } from './route-context.js'

export type ExactRouteHandlers = Record<string, RouteHandler>

export function exactRouteKey(method: string, pathname: string): string {
  return `${method} ${pathname}`
}

export function buildExactRouteHandlers(_deps: ResolvedAcpServerDeps): ExactRouteHandlers {
  return {
    [exactRouteKey('POST', '/v1/tasks')]: handleCreateTask,
    [exactRouteKey('POST', '/v1/inputs')]: handleCreateInput,
    [exactRouteKey('POST', '/v1/messages')]: handleCreateMessage,
    [exactRouteKey('POST', '/v1/runtime/resolve')]: handleResolveRuntime,
    [exactRouteKey('POST', '/v1/sessions/launch')]: handleLaunchSession,
    [exactRouteKey('POST', '/v1/sessions/resolve')]: handleResolveSession,
  }
}
