import type { InterfaceBinding } from 'acp-interface-store'
import type { JobRecord } from 'acp-jobs-store'

export type FlowSummary = {
  enabled: boolean
  stepCount: number
  freshStepCount: number
  freshDurationStepCount: number
}

export type BindingTargetSummary = {
  gatewayId: string
  conversationRef: string
  threadRef?: string | undefined
  scopeRef: string
  laneRef: string
}

function summarizeJobFlow(job: JobRecord): FlowSummary {
  const sequence = job.flow?.sequence ?? []
  const onFailure = job.flow?.onFailure ?? []
  const steps = [...sequence, ...onFailure]
  return {
    enabled: job.flow !== undefined,
    stepCount: steps.length,
    freshStepCount: steps.filter((step) => step.fresh === true).length,
    freshDurationStepCount: steps.filter(
      (step) => typeof step.freshDuration === 'string' && step.freshDuration.trim().length > 0
    ).length,
  }
}

export function jobOperationalFacts(job: JobRecord) {
  return {
    jobId: job.jobId,
    liveSlug: job.slug,
    disabled: job.disabled,
    nextFireAt: job.nextFireAt,
    flowSummary: summarizeJobFlow(job),
  }
}

function compactBindingScopeRef(binding: InterfaceBinding): string {
  if (binding.agentId === undefined || binding.projectId === undefined) {
    return binding.scopeRef
  }
  const taskSegment = binding.taskId === undefined ? '' : `:task:${binding.taskId}`
  return `agent:${binding.agentId}:project:${binding.projectId}${taskSegment}`
}

export function bindingOperationalFacts(binding: InterfaceBinding) {
  return {
    bindingId: binding.bindingId,
    disabled: binding.status === 'disabled',
    bindingTarget: {
      gatewayId: binding.gatewayId,
      conversationRef: binding.conversationRef,
      threadRef: binding.threadRef,
      scopeRef: compactBindingScopeRef(binding),
      laneRef: binding.laneRef,
    },
  }
}

export function driftFacts(drift: { hasDrift: boolean; driftKind?: string | undefined }): {
  hasDrift: boolean
  driftKind?: string | undefined
} {
  return {
    hasDrift: drift.hasDrift,
    driftKind: drift.driftKind,
  }
}
