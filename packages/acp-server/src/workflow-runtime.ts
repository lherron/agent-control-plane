import {
  type ActorRef,
  type WorkflowControlAction,
  type WorkflowResult,
  builtInWorkflowDefinitions,
  createInMemoryWorkflowKernel,
} from 'acp-core'

import type { ResolvedAcpServerDeps } from './deps.js'
import { unprocessable } from './http.js'

function publishBuiltIns(kernel: ReturnType<typeof createInMemoryWorkflowKernel>): void {
  for (const definition of builtInWorkflowDefinitions) {
    if (kernel.getWorkflowDefinition(definition.id, definition.version) === undefined) {
      kernel.publishWorkflowDefinition(definition)
    }
  }
}

export function withDurableWorkflowKernel<T>(
  deps: ResolvedAcpServerDeps,
  mutate: (kernel: ReturnType<typeof createInMemoryWorkflowKernel>) => T,
  options: { save?: boolean | undefined } = {}
): T {
  if (deps.stateStore === undefined) {
    throw new Error('ACP workflow runtime requires stateStore')
  }

  const snapshot = deps.stateStore.workflowRuntime.loadSnapshot()
  const kernel = createInMemoryWorkflowKernel({ snapshot })
  publishBuiltIns(kernel)
  const result = mutate(kernel)
  if (options.save === true) {
    deps.stateStore.workflowRuntime.saveSnapshot(kernel.exportSnapshot())
  }
  return result
}

export function rejectWorkflowResult<T>(result: WorkflowResult<T>): T {
  if (!result.ok) {
    unprocessable(result.error.code, result.error.message, { ...result.error })
  }
  return result
}

export function actorRefFromUnknown(
  value: unknown,
  fallbackAgentId?: string | undefined
): ActorRef {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    if (typeof record['kind'] === 'string' && typeof record['id'] === 'string') {
      return { kind: record['kind'] as ActorRef['kind'], id: record['id'] }
    }
    if (typeof record['agentId'] === 'string' && record['agentId'].trim().length > 0) {
      return { kind: 'agent', id: record['agentId'].trim() }
    }
  }

  if (fallbackAgentId !== undefined) {
    return { kind: 'agent', id: fallbackAgentId }
  }

  throw new Error('actor is required')
}

export function parseWorkflowControlAction(value: unknown): WorkflowControlAction {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('action must be an object')
  }
  return value as WorkflowControlAction
}
