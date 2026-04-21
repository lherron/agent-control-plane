import type { EvidenceItem, InterfaceBinding, LoggedTransitionRecord, Task } from 'acp-core'

export const DEFAULT_ACP_SERVER_URL = 'http://127.0.0.1:18470'

export type FetchLike = (input: Request | string | URL, init?: RequestInit) => Promise<Response>

export type TaskContext = {
  phase: string
  requiredEvidenceKinds: string[]
  hintsText: string
}

export type GetTaskResponse = {
  task: Task
  context?: TaskContext | undefined
}

export type CreateTaskResponse = {
  task: Task
}

export type TaskPromoteResponse = {
  task: Task
  transition: LoggedTransitionRecord
}

export type TaskTransitionResponse = {
  task: Task
  transition: LoggedTransitionRecord
  handoff?: Record<string, unknown> | undefined
  wake?: Record<string, unknown> | undefined
}

export type ListTaskTransitionsResponse = {
  transitions: readonly LoggedTransitionRecord[]
}

export type ListInterfaceBindingsResponse = {
  bindings: readonly InterfaceBinding[]
}

export type UpsertInterfaceBindingResponse = {
  binding: InterfaceBinding
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
    workflowPreset: string
    presetVersion: number
    riskClass: string
    kind: string
    roleMap: Record<string, string>
    meta?: Record<string, unknown> | undefined
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
  }): Promise<TaskPromoteResponse>
  getTask(input: {
    taskId: string
    role?: string | undefined
  }): Promise<GetTaskResponse>
  addEvidence(input: {
    actorAgentId: string
    taskId: string
    evidence: EvidenceItem[]
  }): Promise<null>
  transitionTask(input: {
    actorAgentId: string
    actorRole: string
    taskId: string
    toPhase: string
    expectedVersion: number
    evidenceRefs?: string[] | undefined
    idempotencyKey?: string | undefined
    requestHandoff?: boolean | undefined
    waivers?: EvidenceItem[] | undefined
  }): Promise<TaskTransitionResponse>
  listTransitions(input: { taskId: string }): Promise<ListTaskTransitionsResponse>
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
          workflowPreset: input.workflowPreset,
          presetVersion: input.presetVersion,
          riskClass: input.riskClass,
          kind: input.kind,
          roleMap: input.roleMap,
          actor: { agentId: input.actorAgentId },
          ...(input.meta !== undefined ? { meta: input.meta } : {}),
        },
      })
    },

    promoteTask(input) {
      return request<TaskPromoteResponse>({
        method: 'POST',
        path: `/v1/tasks/${encodeURIComponent(input.taskId)}/promote`,
        actorAgentId: input.actorAgentId,
        body: {
          workflowPreset: input.workflowPreset,
          presetVersion: input.presetVersion,
          riskClass: input.riskClass,
          roleMap: input.roleMap,
          actor: {
            agentId: input.actorAgentId,
            ...(input.actorRole !== undefined ? { role: input.actorRole } : {}),
          },
          ...(input.initialPhase !== undefined ? { initialPhase: input.initialPhase } : {}),
        },
      })
    },

    getTask(input) {
      const query = input.role !== undefined ? `?role=${encodeURIComponent(input.role)}` : ''
      return request<GetTaskResponse>({
        method: 'GET',
        path: `/v1/tasks/${encodeURIComponent(input.taskId)}${query}`,
      })
    },

    addEvidence(input) {
      return request<null>({
        method: 'POST',
        path: `/v1/tasks/${encodeURIComponent(input.taskId)}/evidence`,
        actorAgentId: input.actorAgentId,
        body: {
          actor: { agentId: input.actorAgentId },
          evidence: input.evidence,
        },
      })
    },

    transitionTask(input) {
      return request<TaskTransitionResponse>({
        method: 'POST',
        path: `/v1/tasks/${encodeURIComponent(input.taskId)}/transitions`,
        actorAgentId: input.actorAgentId,
        body: {
          toPhase: input.toPhase,
          expectedVersion: input.expectedVersion,
          actor: { agentId: input.actorAgentId, role: input.actorRole },
          ...(input.evidenceRefs !== undefined ? { evidenceRefs: input.evidenceRefs } : {}),
          ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
          ...(input.requestHandoff === true ? { requestHandoff: true } : {}),
          ...(input.waivers !== undefined ? { waivers: input.waivers } : {}),
        },
      })
    },

    listTransitions(input) {
      return request<ListTaskTransitionsResponse>({
        method: 'GET',
        path: `/v1/tasks/${encodeURIComponent(input.taskId)}/transitions`,
      })
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
  }
}
