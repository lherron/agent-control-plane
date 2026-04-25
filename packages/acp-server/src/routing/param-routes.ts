import { handleGetAdminAgent, handlePatchAdminAgent } from '../handlers/admin-agents.js'
import { handlePostHeartbeatWake, handlePutHeartbeat } from '../handlers/admin-heartbeat.js'
import {
  handleGetAdminJob,
  handlePatchAdminJob,
  handleRunAdminJob,
} from '../handlers/admin-jobs.js'
import { handleListProjectMemberships } from '../handlers/admin-memberships.js'
import { handleGetAdminProject, handleSetProjectDefaultAgent } from '../handlers/admin-projects.js'
import { handleGetConversationThread } from '../handlers/conversation-threads.js'
import { handleListConversationTurns } from '../handlers/conversation-turns.js'
import { handleRequeueDelivery } from '../handlers/delivery-requeue.js'
import { handleAckGatewayDelivery } from '../handlers/gateway-deliveries-ack.js'
import { handleFailGatewayDelivery } from '../handlers/gateway-deliveries-fail.js'
import { handleStreamGatewayDeliveries } from '../handlers/gateway-deliveries-stream.js'
import { handleGetJobRun, handleListJobRuns } from '../handlers/job-runs.js'
import { handleCancelRun } from '../handlers/runs-cancel.js'
import { handleGetRun } from '../handlers/runs-get.js'
import {
  handleListRunOutboundAttachments,
  handlePostRunOutboundAttachment,
} from '../handlers/runs-outbound-attachments.js'
import { handleAttachCommand } from '../handlers/sessions-attach-command.js'
import { handleCaptureSession } from '../handlers/sessions-capture.js'
import { handleSessionEvents } from '../handlers/sessions-events.js'
import { handleGetSession } from '../handlers/sessions-get.js'
import { handleInterruptSession } from '../handlers/sessions-interrupt.js'
import { handleListSessionRuns } from '../handlers/sessions-runs.js'
import { handleAttachTaskEvidence } from '../handlers/tasks-evidence.js'
import { handleGetTask } from '../handlers/tasks-get.js'
import { handlePromoteTask } from '../handlers/tasks-promote.js'
import { handleApplyTaskTransition } from '../handlers/tasks-transition.js'
import { handleListTaskTransitions } from '../handlers/tasks-transitions.js'
import { withActorAndAuthz } from '../middleware/actor-and-authz.js'

import { mutatingRouteSpecs } from './mutating-routes.js'
import type { RouteHandler, RouteParams } from './route-context.js'

export type ParamRoute = {
  method: string
  pattern: RegExp
  extract(pathname: string): RouteParams | undefined
  handler: RouteHandler
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function createParamRoute(
  method: string,
  template: string,
  handler: RouteHandler
): ParamRoute {
  const segments = template.split('/').filter((segment) => segment.length > 0)
  const paramNames: string[] = []
  const pattern = new RegExp(
    `^/${segments
      .map((segment) => {
        if (!segment.startsWith(':')) {
          return escapeRegExp(segment)
        }

        paramNames.push(segment.slice(1))
        return '([^/]+)'
      })
      .join('/')}$`
  )

  return {
    method,
    pattern,
    handler,
    extract(pathname: string): RouteParams | undefined {
      const match = pathname.match(pattern)
      if (match === null) {
        return undefined
      }

      return paramNames.reduce<RouteParams>((params, name, index) => {
        params[name] = decodeURIComponent(match[index + 1] as string)
        return params
      }, {})
    },
  }
}

export function buildParamRoutes(): ParamRoute[] {
  const withSpec = (method: string, template: string, handler: RouteHandler): RouteHandler => {
    const spec = mutatingRouteSpecs[`${method} ${template}`]
    return spec === undefined ? handler : withActorAndAuthz(spec, handler)
  }

  return [
    createParamRoute(
      'GET',
      '/v1/gateway/:gatewayId/deliveries/stream',
      handleStreamGatewayDeliveries
    ),
    createParamRoute(
      'POST',
      '/v1/gateway/deliveries/:deliveryRequestId/ack',
      withSpec('POST', '/v1/gateway/deliveries/:deliveryRequestId/ack', handleAckGatewayDelivery)
    ),
    createParamRoute(
      'POST',
      '/v1/gateway/deliveries/:deliveryRequestId/fail',
      withSpec('POST', '/v1/gateway/deliveries/:deliveryRequestId/fail', handleFailGatewayDelivery)
    ),
    createParamRoute('GET', '/v1/admin/agents/:agentId', handleGetAdminAgent),
    createParamRoute(
      'PATCH',
      '/v1/admin/agents/:agentId',
      withSpec('PATCH', '/v1/admin/agents/:agentId', handlePatchAdminAgent)
    ),
    createParamRoute(
      'PUT',
      '/v1/admin/agents/:agentId/heartbeat',
      withSpec('PUT', '/v1/admin/agents/:agentId/heartbeat', handlePutHeartbeat)
    ),
    createParamRoute('POST', '/v1/admin/agents/:agentId/heartbeat/wake', handlePostHeartbeatWake),
    createParamRoute('GET', '/v1/admin/projects/:projectId', handleGetAdminProject),
    createParamRoute(
      'POST',
      '/v1/admin/projects/:projectId/default-agent',
      withSpec('POST', '/v1/admin/projects/:projectId/default-agent', handleSetProjectDefaultAgent)
    ),
    createParamRoute(
      'GET',
      '/v1/admin/projects/:projectId/memberships',
      handleListProjectMemberships
    ),
    createParamRoute('GET', '/v1/admin/jobs/:jobId', handleGetAdminJob),
    createParamRoute(
      'PATCH',
      '/v1/admin/jobs/:jobId',
      withSpec('PATCH', '/v1/admin/jobs/:jobId', handlePatchAdminJob)
    ),
    createParamRoute(
      'POST',
      '/v1/admin/jobs/:jobId/run',
      withSpec('POST', '/v1/admin/jobs/:jobId/run', handleRunAdminJob)
    ),
    createParamRoute('GET', '/v1/jobs/:jobId/runs', handleListJobRuns),
    createParamRoute('GET', '/v1/job-runs/:jobRunId', handleGetJobRun),
    createParamRoute('GET', '/v1/conversation/threads/:threadId', handleGetConversationThread),
    createParamRoute(
      'GET',
      '/v1/conversation/threads/:threadId/turns',
      handleListConversationTurns
    ),
    createParamRoute(
      'POST',
      '/v1/gateway/deliveries/:deliveryRequestId/requeue',
      withSpec('POST', '/v1/gateway/deliveries/:deliveryRequestId/requeue', handleRequeueDelivery)
    ),
    createParamRoute('GET', '/v1/tasks/:taskId', handleGetTask),
    createParamRoute('POST', '/v1/tasks/:taskId/evidence', handleAttachTaskEvidence),
    createParamRoute('POST', '/v1/tasks/:taskId/promote', handlePromoteTask),
    createParamRoute('POST', '/v1/tasks/:taskId/transitions', handleApplyTaskTransition),
    createParamRoute('GET', '/v1/tasks/:taskId/transitions', handleListTaskTransitions),
    createParamRoute('GET', '/v1/runs/:runId', handleGetRun),
    createParamRoute(
      'GET',
      '/v1/runs/:runId/outbound-attachments',
      handleListRunOutboundAttachments
    ),
    createParamRoute(
      'POST',
      '/v1/runs/:runId/outbound-attachments',
      handlePostRunOutboundAttachment
    ),
    createParamRoute('POST', '/v1/runs/:runId/cancel', handleCancelRun),
    createParamRoute('GET', '/v1/sessions/:sessionId', handleGetSession),
    createParamRoute('GET', '/v1/sessions/:sessionId/runs', handleListSessionRuns),
    createParamRoute('POST', '/v1/sessions/:sessionId/interrupt', handleInterruptSession),
    createParamRoute('GET', '/v1/sessions/:sessionId/capture', handleCaptureSession),
    createParamRoute('GET', '/v1/sessions/:sessionId/attach-command', handleAttachCommand),
    createParamRoute('GET', '/v1/sessions/:sessionId/events', handleSessionEvents),
  ]
}

export function matchParamRoute(
  routes: readonly ParamRoute[],
  method: string,
  pathname: string
): { handler: RouteHandler; params: RouteParams } | undefined {
  for (const route of routes) {
    if (route.method !== method) {
      continue
    }

    const params = route.extract(pathname)
    if (params !== undefined) {
      return {
        handler: route.handler,
        params,
      }
    }
  }

  return undefined
}
