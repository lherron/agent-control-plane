import type { ActorAndAuthzSpec } from '../middleware/actor-and-authz.js'

function readBodyString(body: unknown, field: string): string | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return undefined
  }

  const value = (body as Record<string, unknown>)[field]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

export const mutatingRouteSpecs: Record<string, ActorAndAuthzSpec> = {
  'POST /v1/admin/agents': {
    operation: 'admin.agents.create',
    resource: ({ body }) => ({ kind: 'agent', id: readBodyString(body, 'agentId') }),
  },
  'PATCH /v1/admin/agents/:agentId': {
    operation: 'admin.agents.patch',
    resource: ({ params }) => ({ kind: 'agent', id: params['agentId'] }),
  },
  'PUT /v1/admin/agents/:agentId/heartbeat': {
    operation: 'admin.agents.heartbeat.put',
    resource: ({ params }) => ({ kind: 'agent', id: params['agentId'] }),
  },
  'POST /v1/admin/projects': {
    operation: 'admin.projects.create',
    resource: ({ body }) => ({ kind: 'project', id: readBodyString(body, 'projectId') }),
  },
  'POST /v1/admin/projects/:projectId/default-agent': {
    operation: 'admin.projects.default-agent.set',
    resource: ({ params }) => ({ kind: 'project', id: params['projectId'] }),
  },
  'POST /v1/admin/memberships': {
    operation: 'admin.memberships.create',
    resource: ({ body }) => ({ kind: 'membership', id: readBodyString(body, 'projectId') }),
  },
  'POST /v1/admin/interface-identities': {
    operation: 'admin.interface-identities.create',
    resource: ({ body }) => ({
      kind: 'interface-identity',
      id: readBodyString(body, 'identityId'),
    }),
  },
  'POST /v1/admin/system-events': {
    operation: 'admin.system-events.append',
    resource: ({ body }) => ({ kind: 'project', id: readBodyString(body, 'projectId') }),
  },
  'POST /v1/admin/jobs': {
    operation: 'admin.jobs.create',
    resource: ({ body }) => ({ kind: 'job', id: readBodyString(body, 'jobId') }),
  },
  'PATCH /v1/admin/jobs/:jobId': {
    operation: 'admin.jobs.patch',
    resource: ({ params }) => ({ kind: 'job', id: params['jobId'] }),
  },
  'POST /v1/admin/jobs/:jobId/run': {
    operation: 'admin.job-runs.create',
    resource: ({ params }) => ({ kind: 'job', id: params['jobId'] }),
  },
  'POST /v1/interface/bindings': {
    operation: 'interface.bindings.create',
    resource: ({ body }) => ({ kind: 'binding', id: readBodyString(body, 'bindingId') }),
  },
  'POST /v1/interface/messages': {
    operation: 'interface.messages.create',
    resource: { kind: 'interface-message' },
  },
  'POST /v1/inputs': {
    operation: 'inputs.create',
    resource: { kind: 'input-attempt' },
  },
  'POST /v1/coordination/messages': {
    operation: 'coordination.messages.create',
    resource: ({ body }) => ({ kind: 'project', id: readBodyString(body, 'projectId') }),
  },
  'POST /v1/gateway/deliveries/:deliveryRequestId/ack': {
    operation: 'gateway.deliveries.ack',
    resource: ({ params }) => ({ kind: 'delivery-request', id: params['deliveryRequestId'] }),
  },
  'POST /v1/gateway/deliveries/:deliveryRequestId/fail': {
    operation: 'gateway.deliveries.fail',
    resource: ({ params }) => ({ kind: 'delivery-request', id: params['deliveryRequestId'] }),
  },
  'POST /v1/gateway/deliveries/:deliveryRequestId/requeue': {
    operation: 'gateway.deliveries.requeue',
    resource: ({ params }) => ({ kind: 'delivery-request', id: params['deliveryRequestId'] }),
  },
} as const
