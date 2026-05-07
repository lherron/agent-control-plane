import type { AdminStore } from 'acp-admin-store'
import type { InputAdmissionRecord, InputApplication, InputQueueItem, Run } from 'acp-core'

type AdmissionEventDeps = {
  adminStore?: AdminStore | undefined
}

type AdmissionRun = Run & {
  hostSessionId?: string | undefined
  generation?: number | undefined
  runtimeId?: string | undefined
}

export type AdmissionEventInput = {
  eventKind: string
  scopeRef: string
  laneRef: string
  inputAttemptId: string
  admission?: InputAdmissionRecord | undefined
  run?: AdmissionRun | undefined
  queueItem?: InputQueueItem | undefined
  inputApplication?: InputApplication | undefined
  reason?: string | undefined
  payload?: Record<string, unknown> | undefined
}

function projectIdFromScope(scopeRef: string): string {
  const parts = scopeRef.split(':')
  const projectIndex = parts.findIndex((part) => part === 'project')
  const projectId = projectIndex >= 0 ? parts[projectIndex + 1] : undefined
  return projectId && projectId.length > 0 ? projectId : 'acp'
}

export function recordInputAdmissionEvent(
  deps: AdmissionEventDeps,
  input: AdmissionEventInput
): void {
  if (deps.adminStore === undefined) {
    return
  }

  const occurredAt = new Date().toISOString()
  deps.adminStore.systemEvents.append({
    projectId: projectIdFromScope(input.scopeRef),
    kind: input.eventKind,
    occurredAt,
    recordedAt: occurredAt,
    payload: {
      scopeRef: input.scopeRef,
      laneRef: input.laneRef,
      inputAttemptId: input.inputAttemptId,
      ...(input.admission !== undefined
        ? {
            admissionKind: input.admission.admissionKind,
            admissionStatus: input.admission.status,
            ...(input.admission.runId !== undefined ? { runId: input.admission.runId } : {}),
            ...(input.admission.queueItemId !== undefined
              ? { queueItemId: input.admission.queueItemId }
              : {}),
            ...(input.admission.inputApplicationId !== undefined
              ? { inputApplicationId: input.admission.inputApplicationId }
              : {}),
          }
        : {}),
      ...(input.run !== undefined
        ? {
            runId: input.run.runId,
            runStatus: input.run.status,
            ...(input.run.hostSessionId !== undefined
              ? { hostSessionId: input.run.hostSessionId }
              : {}),
            ...(input.run.generation !== undefined ? { generation: input.run.generation } : {}),
            ...(input.run.runtimeId !== undefined ? { runtimeId: input.run.runtimeId } : {}),
          }
        : {}),
      ...(input.queueItem !== undefined
        ? {
            queueItemId: input.queueItem.queueItemId,
            queueStatus: input.queueItem.status,
            seq: input.queueItem.seq,
            resetPolicy: input.queueItem.resetPolicy,
            ...(input.queueItem.expectedHostSessionId !== undefined
              ? { expectedHostSessionId: input.queueItem.expectedHostSessionId }
              : {}),
            ...(input.queueItem.expectedGeneration !== undefined
              ? { expectedGeneration: input.queueItem.expectedGeneration }
              : {}),
          }
        : {}),
      ...(input.inputApplication !== undefined
        ? {
            inputApplicationId: input.inputApplication.inputApplicationId,
            applicationStatus: input.inputApplication.status,
            ...(input.inputApplication.hostSessionId !== undefined
              ? { hostSessionId: input.inputApplication.hostSessionId }
              : {}),
            ...(input.inputApplication.generation !== undefined
              ? { generation: input.inputApplication.generation }
              : {}),
            ...(input.inputApplication.runtimeId !== undefined
              ? { runtimeId: input.inputApplication.runtimeId }
              : {}),
            ...(input.inputApplication.hrcRunId !== undefined
              ? { hrcRunId: input.inputApplication.hrcRunId }
              : {}),
          }
        : {}),
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      ...(input.payload ?? {}),
    },
  })
}
