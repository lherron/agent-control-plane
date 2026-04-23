import type { Actor, InputAttempt, Run } from 'acp-core'

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
  runId: string
  created: boolean
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
