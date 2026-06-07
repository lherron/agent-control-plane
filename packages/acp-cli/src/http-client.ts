import type {
  ActorRef,
  AdminAgent,
  AdminAgentProfile,
  AdminMembership,
  AdminProject,
  AgentHeartbeat,
  EffectIntent,
  EvidenceInput,
  InterfaceBinding,
  InterfaceIdentity,
  SystemEvent,
  WorkflowEvent,
  WorkflowTask,
} from 'acp-core'

export const DEFAULT_ACP_SERVER_URL = 'http://127.0.0.1:18470'

export type FetchLike = (input: Request | string | URL, init?: RequestInit) => Promise<Response>

export type TaskContext = {
  phase: string
  requiredEvidenceKinds: string[]
  hintsText: string
}

export type WrkfRun = {
  id: string
  role: string
  actor: string
  status: string
  externalRunRef?: string | undefined
  deliveryRef?: string | undefined
  startedAt: string
  completedAt?: string | undefined
  terminalResult?: string | undefined
}

export type GetTaskResponse = {
  source: string
  task: WorkflowTask
  instance: { revision: number; [key: string]: unknown }
  next: unknown
  timeline: WorkflowEvent[]
  evidence: unknown[]
  obligations: unknown[]
  effects: EffectIntent[]
  runs: WrkfRun[]
}

export type CreateTaskResponse = {
  task: WorkflowTask
}

export type AddEvidenceResponse = {
  evidence: Array<{ evidenceId: string; taskId: string; kind: string; ref: string }>
}

export type ObligationLifecycleResponse = {
  task: WorkflowTask
  obligation: {
    obligationId: string
    taskId: string
    status: string
    [key: string]: unknown
  }
}

export type TaskTransitionResponse = {
  task: WorkflowTask
  event: WorkflowEvent
  effects: EffectIntent[]
}

export type ListInterfaceBindingsResponse = {
  bindings: readonly InterfaceBinding[]
}

export type UpsertInterfaceBindingResponse = {
  binding: InterfaceBinding
}

export type CreateAgentResponse = {
  agent: AdminAgent
}

export type ListAgentsResponse = {
  agents: readonly AdminAgent[]
}

export type CreateProjectResponse = {
  project: AdminProject
}

export type ListProjectsResponse = {
  projects: readonly AdminProject[]
}

export type CreateMembershipResponse = {
  membership: AdminMembership
}

export type ListMembershipsResponse = {
  memberships: readonly AdminMembership[]
}

export type RegisterInterfaceIdentityResponse = {
  interfaceIdentity: InterfaceIdentity
}

export type AppendSystemEventResponse = {
  event: SystemEvent
}

export type ListSystemEventsResponse = {
  events: readonly SystemEvent[]
}

export type PutHeartbeatResponse = {
  heartbeat: AgentHeartbeat
}

export type PostHeartbeatWakeResponse = {
  accepted: boolean
  agentId: string
  projectId: string
  wakeId?: string | undefined
}

export type AgentProfilePatchPayload = {
  displayColor?: string | null | undefined
  monogram?: string | null | undefined
  avatarUrl?: string | null | undefined
  tagline?: string | null | undefined
  role?: string | null | undefined
  defaultModel?: string | null | undefined
  vibe?: string[] | null | undefined
  specialties?: string[] | null | undefined
}

export type PatchAgentProfileResponse = {
  agent: { agentId: string; profile?: AdminAgentProfile | undefined }
}

export type AcpErrorBody = {
  error: {
    code: string
    message: string
    details?: Record<string, unknown> | undefined
  }
}

export interface AcpClient {
  createTask(input: {
    actorAgentId: string
    projectId: string
    workflow: { id: string; version: number }
    goal: string
    risk?: string | undefined
    roleBindings: Record<string, ActorRef | null>
    idempotencyKey: string
    meta?: Record<string, unknown> | undefined
    taskId?: string | undefined
    supervisor?:
      | {
          actor: ActorRef
          autonomy?: string | undefined
          capabilities?: Record<string, boolean> | undefined
        }
      | undefined
  }): Promise<CreateTaskResponse>
  promoteTask(input: {
    actorAgentId: string
    taskId: string
    workflowPreset: string
    presetVersion: number
    riskClass: string
    roleMap: Record<string, string>
    actorRole?: string | undefined
    initialPhase?: string | undefined
  }): Promise<never>
  getTask(input: {
    taskId: string
    role?: string | undefined
  }): Promise<GetTaskResponse>
  addEvidence(input: {
    actorAgentId: string
    taskId: string
    role?: string | undefined
    runId?: string | undefined
    supervisorRunId?: string | undefined
    participantRunId?: string | undefined
    evidence: Array<{ kind: string; ref: string; summary?: string | undefined }>
    idempotencyKey: string
  }): Promise<AddEvidenceResponse>
  transitionTask(input: {
    actorAgentId: string
    taskId: string
    transitionId: string
    role: string
    expectedTaskVersion: number
    contextHash?: string | undefined
    inlineEvidence?: EvidenceInput[] | undefined
    evidenceRefs?: string[] | undefined
    waiverRefs?: string[] | undefined
    idempotencyKey: string
    runId?: string | undefined
  }): Promise<TaskTransitionResponse>
  waiveObligation(input: {
    actorAgentId: string
    taskId: string
    obligationId: string
    reason: string
    evidenceRefs?: string[] | undefined
    idempotencyKey: string
  }): Promise<ObligationLifecycleResponse>
  cancelObligation(input: {
    actorAgentId: string
    taskId: string
    obligationId: string
    reason?: string | undefined
    idempotencyKey: string
  }): Promise<ObligationLifecycleResponse>
  listTransitions(input: { taskId: string }): Promise<never>
  listInterfaceBindings(input: {
    gatewayId?: string | undefined
    conversationRef?: string | undefined
    threadRef?: string | undefined
    projectId?: string | undefined
  }): Promise<ListInterfaceBindingsResponse>
  upsertInterfaceBinding(input: {
    actorAgentId?: string | undefined
    gatewayId: string
    conversationRef: string
    threadRef?: string | undefined
    projectId?: string | undefined
    sessionRef: {
      scopeRef: string
      laneRef?: string | undefined
    }
    status?: 'active' | 'disabled' | undefined
  }): Promise<UpsertInterfaceBindingResponse>
  createAgent(input: {
    actorAgentId: string
    agentId: string
    displayName?: string | undefined
    homeDir?: string | undefined
    status: 'active' | 'disabled'
  }): Promise<CreateAgentResponse>
  listAgents(): Promise<ListAgentsResponse>
  getAgent(input: { agentId: string }): Promise<CreateAgentResponse>
  patchAgent(input: {
    actorAgentId: string
    agentId: string
    displayName?: string | undefined
    homeDir?: string | undefined
    status?: 'active' | 'disabled' | undefined
  }): Promise<CreateAgentResponse>
  createProject(input: {
    actorAgentId: string
    projectId: string
    displayName: string
    homeDir?: string | undefined
    rootDir?: string | undefined
  }): Promise<CreateProjectResponse>
  listProjects(): Promise<ListProjectsResponse>
  getProject(input: { projectId: string }): Promise<CreateProjectResponse>
  setProjectDefaultAgent(input: {
    actorAgentId: string
    projectId: string
    agentId: string
  }): Promise<CreateProjectResponse>
  addMembership(input: {
    actorAgentId: string
    projectId: string
    agentId: string
    role: 'coordinator' | 'implementer' | 'tester' | 'observer'
  }): Promise<CreateMembershipResponse>
  listMemberships(input: { projectId: string }): Promise<ListMembershipsResponse>
  registerInterfaceIdentity(input: {
    gatewayId: string
    externalId: string
    displayName?: string | undefined
    linkedAgentId?: string | undefined
  }): Promise<RegisterInterfaceIdentityResponse>
  appendSystemEvent(input: {
    projectId: string
    kind: string
    payload: Record<string, unknown>
    occurredAt: string
  }): Promise<AppendSystemEventResponse>
  listSystemEvents(input?: {
    projectId?: string | undefined
    kind?: string | undefined
    occurredAfter?: string | undefined
    occurredBefore?: string | undefined
  }): Promise<ListSystemEventsResponse>
  putHeartbeat(input: {
    agentId: string
    source?: string | undefined
    note?: string | undefined
    scopeRef?: string | undefined
    laneRef?: string | undefined
  }): Promise<PutHeartbeatResponse>
  postHeartbeatWake(input: {
    agentId: string
    scopeRef?: string | undefined
    laneRef?: string | undefined
  }): Promise<PostHeartbeatWakeResponse>
  patchAgentProfile(input: {
    actorAgentId: string
    agentId: string
    profile: AgentProfilePatchPayload
  }): Promise<PatchAgentProfileResponse>
}

export class AcpClientHttpError extends Error {
  readonly status: number
  readonly body: unknown

  constructor(status: number, body: unknown) {
    super(resolveErrorMessage(status, body))
    this.name = 'AcpClientHttpError'
    this.status = status
    this.body = body
  }
}

export class AcpClientTransportError extends Error {
  constructor(message: string, options?: { cause?: unknown | undefined }) {
    super(message, options)
    this.name = 'AcpClientTransportError'
  }
}

function resolveErrorMessage(status: number, body: unknown): string {
  if (isAcpErrorBody(body)) {
    return body.error.message
  }
  if (typeof body === 'string' && body.trim().length > 0) {
    return body
  }
  return `request failed with status ${status}`
}

export function isAcpErrorBody(value: unknown): value is AcpErrorBody {
  return (
    typeof value === 'object' &&
    value !== null &&
    'error' in value &&
    typeof (value as { error?: unknown }).error === 'object' &&
    (value as { error?: { code?: unknown; message?: unknown } }).error !== null &&
    typeof (value as { error: { code?: unknown } }).error.code === 'string' &&
    typeof (value as { error: { message?: unknown } }).error.message === 'string'
  )
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text()
  if (text.length === 0) {
    return null
  }

  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

function trimTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, '')
}

export function createHttpClient(
  options: {
    serverUrl?: string | undefined
    actorAgentId?: string | undefined
    fetchImpl?: FetchLike | undefined
  } = {}
): AcpClient {
  const baseUrl = trimTrailingSlashes(options.serverUrl ?? DEFAULT_ACP_SERVER_URL)
  const fetchImpl = options.fetchImpl ?? fetch

  async function request<T>(input: {
    method: string
    path: string
    body?: unknown
    actorAgentId?: string | undefined
  }): Promise<T> {
    const headers = new Headers()
    if (input.body !== undefined) {
      headers.set('content-type', 'application/json')
    }

    const actorAgentId = input.actorAgentId ?? options.actorAgentId
    if (actorAgentId !== undefined) {
      headers.set('x-acp-actor-agent-id', actorAgentId)
    }

    let response: Response
    try {
      response = await fetchImpl(`${baseUrl}${input.path}`, {
        method: input.method,
        headers,
        ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
      })
    } catch (error) {
      throw new AcpClientTransportError(`failed to reach ACP server at ${baseUrl}`, {
        cause: error,
      })
    }

    const body = await readBody(response)
    if (!response.ok) {
      throw new AcpClientHttpError(response.status, body)
    }

    return body as T
  }

  return {
    createTask(input) {
      return request<CreateTaskResponse>({
        method: 'POST',
        path: '/v1/tasks',
        actorAgentId: input.actorAgentId,
        body: {
          projectId: input.projectId,
          workflow: input.workflow,
          goal: input.goal,
          ...(input.risk !== undefined ? { risk: input.risk } : {}),
          roleBindings: input.roleBindings,
          idempotencyKey: input.idempotencyKey,
          actor: { agentId: input.actorAgentId },
          ...(input.meta !== undefined ? { initialFacts: input.meta } : {}),
          ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
          ...(input.supervisor !== undefined ? { supervisor: input.supervisor } : {}),
        },
      })
    },

    promoteTask() {
      throw new AcpClientTransportError('legacy task promote route has been removed')
    },

    getTask(input) {
      const query = input.role !== undefined ? `?role=${encodeURIComponent(input.role)}` : ''
      return request<GetTaskResponse>({
        method: 'GET',
        path: `/v1/tasks/${encodeURIComponent(input.taskId)}${query}`,
      })
    },

    addEvidence(input) {
      const evidence = input.evidence[0]
      return request<AddEvidenceResponse>({
        method: 'POST',
        path: `/v1/tasks/${encodeURIComponent(input.taskId)}/evidence`,
        actorAgentId: input.actorAgentId,
        body: {
          actor: { kind: 'agent', id: input.actorAgentId },
          ...(input.role !== undefined ? { role: input.role } : {}),
          ...(input.runId !== undefined ? { runId: input.runId } : {}),
          ...(input.supervisorRunId !== undefined
            ? { supervisorRunId: input.supervisorRunId }
            : {}),
          ...(input.participantRunId !== undefined
            ? { participantRunId: input.participantRunId }
            : {}),
          ...(evidence !== undefined
            ? {
                kind: evidence.kind,
                ref: evidence.ref,
                ...(evidence.summary !== undefined ? { summary: evidence.summary } : {}),
              }
            : {}),
          idempotencyKey: input.idempotencyKey,
        },
      })
    },

    transitionTask(input) {
      return request<TaskTransitionResponse>({
        method: 'POST',
        path: `/v1/tasks/${encodeURIComponent(input.taskId)}/transitions`,
        actorAgentId: input.actorAgentId,
        body: {
          transitionId: input.transitionId,
          role: input.role,
          expectedTaskVersion: input.expectedTaskVersion,
          actor: { agentId: input.actorAgentId },
          idempotencyKey: input.idempotencyKey,
          ...(input.contextHash !== undefined ? { contextHash: input.contextHash } : {}),
          ...(input.inlineEvidence !== undefined ? { inlineEvidence: input.inlineEvidence } : {}),
          ...(input.evidenceRefs !== undefined ? { evidenceRefs: input.evidenceRefs } : {}),
          ...(input.waiverRefs !== undefined ? { waiverRefs: input.waiverRefs } : {}),
          ...(input.runId !== undefined ? { runId: input.runId } : {}),
        },
      })
    },

    waiveObligation(input) {
      return request<ObligationLifecycleResponse>({
        method: 'POST',
        path: `/v1/tasks/${encodeURIComponent(input.taskId)}/obligations/${encodeURIComponent(input.obligationId)}/waive`,
        actorAgentId: input.actorAgentId,
        body: {
          actor: { kind: 'agent', id: input.actorAgentId },
          reason: input.reason,
          ...(input.evidenceRefs !== undefined ? { evidenceRefs: input.evidenceRefs } : {}),
          idempotencyKey: input.idempotencyKey,
        },
      })
    },

    cancelObligation(input) {
      return request<ObligationLifecycleResponse>({
        method: 'POST',
        path: `/v1/tasks/${encodeURIComponent(input.taskId)}/obligations/${encodeURIComponent(input.obligationId)}/cancel`,
        actorAgentId: input.actorAgentId,
        body: {
          actor: { kind: 'agent', id: input.actorAgentId },
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
          idempotencyKey: input.idempotencyKey,
        },
      })
    },

    listTransitions() {
      throw new AcpClientTransportError('legacy task transitions route has been removed')
    },

    listInterfaceBindings(input) {
      const query = new URLSearchParams()
      if (input.gatewayId !== undefined) {
        query.set('gatewayId', input.gatewayId)
      }
      if (input.conversationRef !== undefined) {
        query.set('conversationRef', input.conversationRef)
      }
      if (input.threadRef !== undefined) {
        query.set('threadRef', input.threadRef)
      }
      if (input.projectId !== undefined) {
        query.set('projectId', input.projectId)
      }

      const suffix = query.size > 0 ? `?${query.toString()}` : ''
      return request<ListInterfaceBindingsResponse>({
        method: 'GET',
        path: `/v1/interface/bindings${suffix}`,
      })
    },

    upsertInterfaceBinding(input) {
      return request<UpsertInterfaceBindingResponse>({
        method: 'POST',
        path: '/v1/interface/bindings',
        ...(input.actorAgentId !== undefined ? { actorAgentId: input.actorAgentId } : {}),
        body: {
          gatewayId: input.gatewayId,
          conversationRef: input.conversationRef,
          ...(input.threadRef !== undefined ? { threadRef: input.threadRef } : {}),
          ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
          sessionRef: {
            scopeRef: input.sessionRef.scopeRef,
            ...(input.sessionRef.laneRef !== undefined
              ? { laneRef: input.sessionRef.laneRef }
              : {}),
          },
          ...(input.status !== undefined ? { status: input.status } : {}),
        },
      })
    },

    createAgent(input) {
      return request<CreateAgentResponse>({
        method: 'POST',
        path: '/v1/admin/agents',
        actorAgentId: input.actorAgentId,
        body: {
          agentId: input.agentId,
          ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
          ...(input.homeDir !== undefined ? { homeDir: input.homeDir } : {}),
          status: input.status,
          actor: { kind: 'agent', id: input.actorAgentId },
        },
      })
    },

    listAgents() {
      return request<ListAgentsResponse>({
        method: 'GET',
        path: '/v1/admin/agents',
      })
    },

    getAgent(input) {
      return request<CreateAgentResponse>({
        method: 'GET',
        path: `/v1/admin/agents/${encodeURIComponent(input.agentId)}`,
      })
    },

    patchAgent(input) {
      return request<CreateAgentResponse>({
        method: 'PATCH',
        path: `/v1/admin/agents/${encodeURIComponent(input.agentId)}`,
        actorAgentId: input.actorAgentId,
        body: {
          ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
          ...(input.homeDir !== undefined ? { homeDir: input.homeDir } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          actor: { kind: 'agent', id: input.actorAgentId },
        },
      })
    },

    createProject(input) {
      return request<CreateProjectResponse>({
        method: 'POST',
        path: '/v1/admin/projects',
        actorAgentId: input.actorAgentId,
        body: {
          projectId: input.projectId,
          displayName: input.displayName,
          ...(input.homeDir !== undefined ? { homeDir: input.homeDir } : {}),
          ...(input.rootDir !== undefined ? { rootDir: input.rootDir } : {}),
          actor: { kind: 'agent', id: input.actorAgentId },
        },
      })
    },

    listProjects() {
      return request<ListProjectsResponse>({
        method: 'GET',
        path: '/v1/admin/projects',
      })
    },

    getProject(input) {
      return request<CreateProjectResponse>({
        method: 'GET',
        path: `/v1/admin/projects/${encodeURIComponent(input.projectId)}`,
      })
    },

    setProjectDefaultAgent(input) {
      return request<CreateProjectResponse>({
        method: 'POST',
        path: `/v1/admin/projects/${encodeURIComponent(input.projectId)}/default-agent`,
        actorAgentId: input.actorAgentId,
        body: {
          agentId: input.agentId,
          actor: { kind: 'agent', id: input.actorAgentId },
        },
      })
    },

    addMembership(input) {
      return request<CreateMembershipResponse>({
        method: 'POST',
        path: '/v1/admin/memberships',
        actorAgentId: input.actorAgentId,
        body: {
          projectId: input.projectId,
          agentId: input.agentId,
          role: input.role,
          actor: { kind: 'agent', id: input.actorAgentId },
        },
      })
    },

    listMemberships(input) {
      return request<ListMembershipsResponse>({
        method: 'GET',
        path: `/v1/admin/projects/${encodeURIComponent(input.projectId)}/memberships`,
      })
    },

    registerInterfaceIdentity(input) {
      return request<RegisterInterfaceIdentityResponse>({
        method: 'POST',
        path: '/v1/admin/interface-identities',
        body: {
          gatewayId: input.gatewayId,
          externalId: input.externalId,
          ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
          ...(input.linkedAgentId !== undefined ? { linkedAgentId: input.linkedAgentId } : {}),
        },
      })
    },

    appendSystemEvent(input) {
      return request<AppendSystemEventResponse>({
        method: 'POST',
        path: '/v1/admin/system-events',
        body: {
          projectId: input.projectId,
          kind: input.kind,
          payload: input.payload,
          occurredAt: input.occurredAt,
        },
      })
    },

    listSystemEvents(input = {}) {
      const query = new URLSearchParams()
      if (input.projectId !== undefined) {
        query.set('projectId', input.projectId)
      }
      if (input.kind !== undefined) {
        query.set('kind', input.kind)
      }
      if (input.occurredAfter !== undefined) {
        query.set('occurredAfter', input.occurredAfter)
      }
      if (input.occurredBefore !== undefined) {
        query.set('occurredBefore', input.occurredBefore)
      }

      const suffix = query.size > 0 ? `?${query.toString()}` : ''
      return request<ListSystemEventsResponse>({
        method: 'GET',
        path: `/v1/admin/system-events${suffix}`,
      })
    },

    putHeartbeat(input) {
      return request<PutHeartbeatResponse>({
        method: 'PUT',
        path: `/v1/admin/agents/${encodeURIComponent(input.agentId)}/heartbeat`,
        body: {
          ...(input.source !== undefined ? { source: input.source } : {}),
          ...(input.note !== undefined ? { note: input.note } : {}),
          ...(input.scopeRef !== undefined ? { scopeRef: input.scopeRef } : {}),
          ...(input.laneRef !== undefined ? { laneRef: input.laneRef } : {}),
        },
      })
    },

    postHeartbeatWake(input) {
      return request<PostHeartbeatWakeResponse>({
        method: 'POST',
        path: `/v1/admin/agents/${encodeURIComponent(input.agentId)}/heartbeat/wake`,
        body: {
          ...(input.scopeRef !== undefined ? { scopeRef: input.scopeRef } : {}),
          ...(input.laneRef !== undefined ? { laneRef: input.laneRef } : {}),
        },
      })
    },

    patchAgentProfile(input) {
      return request<PatchAgentProfileResponse>({
        method: 'PATCH',
        path: `/v1/admin/agents/${encodeURIComponent(input.agentId)}/profile`,
        actorAgentId: input.actorAgentId,
        body: {
          ...input.profile,
          actor: { kind: 'agent', id: input.actorAgentId },
        },
      })
    },
  }
}
