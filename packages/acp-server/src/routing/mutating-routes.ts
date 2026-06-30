import type { ActorAndAuthzSpec } from '../middleware/actor-and-authz.js'

function readBodyString(body: unknown, field: string): string | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return undefined
  }

  const value = (body as Record<string, unknown>)[field]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function readPlanOwnerScopeRef(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return undefined
  }

  const plan = (body as Record<string, unknown>)['plan']
  return readBodyString(plan, 'sourceOwnerScopeRef')
}

export const mutatingRouteSpecs: Record<string, ActorAndAuthzSpec> = {
  'GET /v1/wrkf/pbc/tasks/:task/inspect': {
    operation: 'wrkf.pbc.inspect',
    resource: ({ params }) => ({ kind: 'wrkf-task', id: params['task'] }),
  },
  'POST /v1/admin/agents': {
    operation: 'admin.agents.create',
    resource: ({ body }) => ({ kind: 'agent', id: readBodyString(body, 'agentId') }),
  },
  'PATCH /v1/admin/agents/:agentId': {
    operation: 'admin.agents.patch',
    resource: ({ params }) => ({ kind: 'agent', id: params['agentId'] }),
  },
  'PATCH /v1/admin/agents/:agentId/profile': {
    operation: 'admin.agents.profile.patch',
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
  'POST /v1/admin/jobs/validate': {
    operation: 'admin.jobs.validate',
    resource: ({ body }) => ({ kind: 'project', id: readBodyString(body, 'projectId') }),
  },
  'POST /v1/admin/contributions/reconcile': {
    operation: 'admin.contributions.reconcile',
    resource: ({ body }) => ({
      kind: 'input-application',
      id: readBodyString(body, 'inputApplicationId'),
    }),
  },
  'POST /v1/admin/managed-resources/apply': {
    operation: 'admin.managed-resources.apply',
    resource: ({ body }) => ({
      kind: 'project',
      id: readPlanOwnerScopeRef(body),
    }),
  },
  'POST /v1/admin/managed-resources/status': {
    operation: 'admin.managed-resources.status',
    resource: ({ body }) => ({
      kind: 'project',
      // Plan-aware status scopes authorization to plan.sourceOwnerScopeRef; the
      // legacy owner-only form remains scoped to ownerScopeRef.
      id: readPlanOwnerScopeRef(body) ?? readBodyString(body, 'ownerScopeRef'),
    }),
  },
  'POST /v1/admin/managed-resources/reconcile': {
    operation: 'admin.managed-resources.reconcile',
    resource: ({ body }) => ({
      kind: 'project',
      id: readPlanOwnerScopeRef(body),
    }),
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
  'POST /v1/runs/:runId/outbound-messages': {
    operation: 'runs.outbound-messages.create',
    resource: ({ params }) => ({ kind: 'run', id: params['runId'] }),
  },
  'POST /v1/tasks/:taskId/obligations/:obligationId/satisfy': {
    operation: 'wrkf.obligations.satisfy',
    resource: ({ params }) => ({ kind: 'wrkf-obligation', id: params['obligationId'] }),
  },
  'POST /v1/wrkf/pbc/tasks/:task/run-step': {
    operation: 'wrkf.pbc.run-step',
    resource: ({ params }) => ({ kind: 'wrkf-task', id: params['task'] }),
    parseActorBody: false,
  },
  'POST /v1/wrkf/pbc/tasks/:task/approve-transition': {
    operation: 'wrkf.pbc.approve-transition',
    resource: ({ params }) => ({ kind: 'wrkf-task', id: params['task'] }),
    parseActorBody: false,
  },
  'POST /v1/wrkf/pbc/tasks/:task/run-until-blocked': {
    operation: 'wrkf.pbc.run-until-blocked',
    resource: ({ params }) => ({ kind: 'wrkf-task', id: params['task'] }),
    parseActorBody: false,
  },
  'POST /v1/wrkf/effects/deliver': {
    operation: 'wrkf.effects.deliver',
    resource: ({ body }) => ({ kind: 'wrkf-task', id: readBodyString(body, 'task') }),
  },
  'POST /v1/wrkf/actions/launch': {
    operation: 'wrkf.actions.launch',
    resource: ({ body }) => ({ kind: 'wrkf-task', id: readBodyString(body, 'taskId') }),
  },
  'POST /v1/pbc/tasks/:taskId/start': {
    operation: 'pbc.tasks.start',
    resource: ({ params }) => ({ kind: 'wrkf-task', id: params['taskId'] }),
  },
  'POST /v1/pbc/tasks/:taskId/input': {
    operation: 'pbc.tasks.input',
    resource: ({ params }) => ({ kind: 'wrkf-task', id: params['taskId'] }),
  },
  'POST /v1/pbc/tasks/:taskId/continue': {
    operation: 'pbc.tasks.continue',
    resource: ({ params }) => ({ kind: 'wrkf-task', id: params['taskId'] }),
  },
  'POST /v1/pbc/tasks/:taskId/dispose': {
    operation: 'pbc.tasks.dispose',
    resource: ({ params }) => ({ kind: 'wrkf-task', id: params['taskId'] }),
  },
  'POST /v1/pbc/tasks/:taskId/effects/reconcile': {
    operation: 'pbc.tasks.effects.reconcile',
    resource: ({ params }) => ({ kind: 'wrkf-task', id: params['taskId'] }),
  },
} as const
