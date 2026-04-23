import { handleCreateAdminJob, handleListAdminJobs } from '../handlers/admin-jobs.js'
import { handleCreateAdminAgent, handleListAdminAgents } from '../handlers/admin-agents.js'
import {
  handleListInterfaceIdentities,
  handleRegisterInterfaceIdentity,
} from '../handlers/admin-interface-identities.js'
import {
  handleCreateMembership,
  handleListMemberships,
} from '../handlers/admin-memberships.js'
import {
  handleCreateAdminProject,
  handleListAdminProjects,
} from '../handlers/admin-projects.js'
import {
  handleAppendSystemEvent,
  handleListSystemEvents,
} from '../handlers/admin-system-events.js'
import { handleCreateCoordinationMessage } from '../handlers/coordination-messages.js'
import { handleListConversationThreads } from '../handlers/conversation-threads.js'
import { handleListFailedDeliveries } from '../handlers/delivery-list-failed.js'
import { handleCreateInput } from '../handlers/inputs.js'
import { handleCreateInterfaceBinding } from '../handlers/interface-bindings-create.js'
import { handleListInterfaceBindings } from '../handlers/interface-bindings-list.js'
import { handleCreateInterfaceMessage } from '../handlers/interface-messages.js'
import { handleCreateMessage } from '../handlers/messages.js'
import { handleResolveRuntime } from '../handlers/runtime-resolve.js'
import { handleListSessions } from '../handlers/sessions-list.js'
import { handleResetSession } from '../handlers/sessions-reset.js'
import { handleResolveSession } from '../handlers/sessions-resolve.js'
import { handleCreateTask } from '../handlers/tasks-create.js'
import { handleLaunchSession } from '../launch-role-scoped.js'
import { withActorAndAuthz } from '../middleware/actor-and-authz.js'

import type { ResolvedAcpServerDeps } from '../deps.js'
import { mutatingRouteSpecs } from './mutating-routes.js'
import type { RouteHandler } from './route-context.js'

export type ExactRouteHandlers = Record<string, RouteHandler>

export function exactRouteKey(method: string, pathname: string): string {
  return `${method} ${pathname}`
}

function maybeWrapMutatingRoute(method: string, pathname: string, handler: RouteHandler): RouteHandler {
  const spec = mutatingRouteSpecs[exactRouteKey(method, pathname)]
  return spec === undefined ? handler : withActorAndAuthz(spec, handler)
}

export function buildExactRouteHandlers(_deps: ResolvedAcpServerDeps): ExactRouteHandlers {
  return {
    [exactRouteKey('POST', '/v1/interface/bindings')]: maybeWrapMutatingRoute(
      'POST',
      '/v1/interface/bindings',
      handleCreateInterfaceBinding
    ),
    [exactRouteKey('GET', '/v1/interface/bindings')]: handleListInterfaceBindings,
    [exactRouteKey('POST', '/v1/interface/messages')]: maybeWrapMutatingRoute(
      'POST',
      '/v1/interface/messages',
      handleCreateInterfaceMessage
    ),
    [exactRouteKey('POST', '/v1/tasks')]: handleCreateTask,
    [exactRouteKey('POST', '/v1/inputs')]: maybeWrapMutatingRoute(
      'POST',
      '/v1/inputs',
      handleCreateInput
    ),
    [exactRouteKey('POST', '/v1/messages')]: handleCreateMessage,
    [exactRouteKey('POST', '/v1/admin/agents')]: maybeWrapMutatingRoute(
      'POST',
      '/v1/admin/agents',
      handleCreateAdminAgent
    ),
    [exactRouteKey('GET', '/v1/admin/agents')]: handleListAdminAgents,
    [exactRouteKey('POST', '/v1/admin/projects')]: maybeWrapMutatingRoute(
      'POST',
      '/v1/admin/projects',
      handleCreateAdminProject
    ),
    [exactRouteKey('GET', '/v1/admin/projects')]: handleListAdminProjects,
    [exactRouteKey('POST', '/v1/admin/memberships')]: maybeWrapMutatingRoute(
      'POST',
      '/v1/admin/memberships',
      handleCreateMembership
    ),
    [exactRouteKey('GET', '/v1/admin/memberships')]: handleListMemberships,
    [exactRouteKey('POST', '/v1/admin/interface-identities')]: maybeWrapMutatingRoute(
      'POST',
      '/v1/admin/interface-identities',
      handleRegisterInterfaceIdentity
    ),
    [exactRouteKey('GET', '/v1/admin/interface-identities')]: handleListInterfaceIdentities,
    [exactRouteKey('POST', '/v1/admin/system-events')]: maybeWrapMutatingRoute(
      'POST',
      '/v1/admin/system-events',
      handleAppendSystemEvent
    ),
    [exactRouteKey('GET', '/v1/admin/system-events')]: handleListSystemEvents,
    [exactRouteKey('POST', '/v1/admin/jobs')]: maybeWrapMutatingRoute(
      'POST',
      '/v1/admin/jobs',
      handleCreateAdminJob
    ),
    [exactRouteKey('GET', '/v1/admin/jobs')]: handleListAdminJobs,
    [exactRouteKey('GET', '/v1/conversation/threads')]: handleListConversationThreads,
    [exactRouteKey('POST', '/v1/coordination/messages')]: maybeWrapMutatingRoute(
      'POST',
      '/v1/coordination/messages',
      handleCreateCoordinationMessage
    ),
    [exactRouteKey('GET', '/v1/gateway/deliveries')]: handleListFailedDeliveries,
    [exactRouteKey('POST', '/v1/runtime/resolve')]: handleResolveRuntime,
    [exactRouteKey('POST', '/v1/sessions/launch')]: handleLaunchSession,
    [exactRouteKey('POST', '/v1/sessions/resolve')]: handleResolveSession,
    [exactRouteKey('GET', '/v1/sessions')]: handleListSessions,
    [exactRouteKey('POST', '/v1/sessions/reset')]: handleResetSession,
  }
}
