import type {
  Actor,
  InputAdmissionKind,
  InputAdmissionRecord,
  InputApplication,
  InputApplicationStatus,
  InputAttempt,
  InputIntent,
  InputQueueItem,
  InputQueueStatus,
  InputResetPolicy,
  Run,
} from 'acp-core'

export type DispatchFence = {
  expectedHostSessionId?: string | undefined
  expectedGeneration?: number | undefined
  followLatest?: boolean | undefined
}

export type StoredRun = Run & {
  updatedAt: string
  hrcRunId?: string | undefined
  hostSessionId?: string | undefined
  generation?: number | undefined
  runtimeId?: string | undefined
  transport?: string | undefined
  errorCode?: string | undefined
  errorMessage?: string | undefined
  dispatchFence?: DispatchFence | undefined
}

export type UpdateRunInput = {
  status?: Run['status'] | undefined
  hrcRunId?: string | undefined
  hostSessionId?: string | undefined
  generation?: number | undefined
  runtimeId?: string | undefined
  transport?: string | undefined
  errorCode?: string | undefined
  errorMessage?: string | undefined
  metadata?: Readonly<Record<string, unknown>> | undefined
}

export type StoredInputAttempt = InputAttempt

export type InputAttemptCreateResult = {
  inputAttempt: StoredInputAttempt
  runId?: string | undefined
  created: boolean
}

export type CreateInputAttemptInput = {
  sessionRef: { scopeRef: string; laneRef: string }
  taskId?: string | undefined
  idempotencyKey?: string | undefined
  content: string
  actor?: Actor | { agentId: string } | undefined
  metadata?: Readonly<Record<string, unknown>> | undefined
  associatedRunId?: string | undefined
  runStore?:
    | {
        createRun(input: {
          sessionRef: { scopeRef: string; laneRef: string }
          taskId?: string | undefined
          actor?: Actor | undefined
          metadata?: Readonly<Record<string, unknown>> | undefined
        }): { runId: string }
      }
    | undefined
}

export type InputAdmissionCreateInput = {
  inputAttemptId: string
  admissionKind: InputAdmissionKind
  intent: InputIntent
  originalResponse: Readonly<Record<string, unknown>>
  currentState?: Readonly<Record<string, unknown>> | undefined
  runId?: string | undefined
  inputApplicationId?: string | undefined
  queueItemId?: string | undefined
  status: string
}

export type InputAdmissionUpdateInput = {
  currentState?: Readonly<Record<string, unknown>> | undefined
  status?: string | undefined
  runId?: string | undefined
  inputApplicationId?: string | undefined
  queueItemId?: string | undefined
}

export type InputQueueCreateInput = {
  inputAttemptId: string
  runId: string
  scopeRef: string
  laneRef: string
  seq: number
  status?: InputQueueStatus | undefined
  resetPolicy?: InputResetPolicy | undefined
  expectedHostSessionId?: string | undefined
  expectedGeneration?: number | undefined
  notBeforeAt?: string | undefined
}

export type InputQueueUpdateInput = {
  status?: InputQueueStatus | undefined
  notBeforeAt?: string | undefined
  leasedAt?: string | undefined
  leaseOwner?: string | undefined
  attempts?: number | undefined
  lastErrorCode?: string | undefined
  lastErrorMessage?: string | undefined
}

export type InputApplicationCreateInput = {
  inputAttemptId: string
  targetRunId?: string | undefined
  hrcRunId?: string | undefined
  hostSessionId?: string | undefined
  generation?: number | undefined
  runtimeId?: string | undefined
  status?: InputApplicationStatus | undefined
}

export type InputApplicationUpdateInput = {
  status?: InputApplicationStatus | undefined
  hrcRunId?: string | undefined
  hostSessionId?: string | undefined
  generation?: number | undefined
  runtimeId?: string | undefined
  deliveryAttempts?: number | undefined
  lastErrorCode?: string | undefined
  lastErrorMessage?: string | undefined
}

export type {
  InputAdmissionRecord,
  InputApplication,
  InputQueueItem,
  InputQueueStatus,
  InputResetPolicy,
}

export type TransitionOutboxStatus = 'pending' | 'leased' | 'delivered' | 'failed'

export type TransitionOutboxRecord = {
  transitionEventId: string
  taskId: string
  projectId: string
  fromPhase: string
  toPhase: string
  actor: Actor
  payload: Readonly<Record<string, unknown>>
  status: TransitionOutboxStatus
  leasedAt?: string | undefined
  deliveredAt?: string | undefined
  attempts: number
  lastError?: string | undefined
  createdAt: string
}

export type AppendTransitionOutboxInput = {
  transitionEventId: string
  taskId: string
  projectId: string
  fromPhase: string
  toPhase: string
  actor?: Actor | undefined
  payload: Readonly<Record<string, unknown>>
}

export class InputAttemptConflictError extends Error {
  readonly idempotencyKey: string

  constructor(idempotencyKey: string) {
    super(`different request body already exists for idempotencyKey ${idempotencyKey}`)
    this.name = 'InputAttemptConflictError'
    this.idempotencyKey = idempotencyKey
  }
}
