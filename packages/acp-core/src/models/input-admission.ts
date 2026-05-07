export type InputIntent =
  | { kind: 'new_work'; resetPolicy?: InputResetPolicy | undefined }
  | {
      kind: 'contribute_to_active_run'
      fallback: 'queue' | 'reject' | 'pending_only'
      contributionSemantics?: 'append_context' | 'interrupt_and_continue' | undefined
    }
  | {
      kind: 'control_active_run'
      action: 'interrupt' | 'cancel' | 'pause'
      fallback?: 'reject' | undefined
    }

export type InputAdmissionKind =
  | 'started_run'
  | 'queued_run'
  | 'accepted_in_flight'
  | 'admission_pending'
  | 'rejected'

export type InputQueueStatus =
  | 'queued'
  | 'leased'
  | 'dispatching'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'expired'

export type InputApplicationStatus =
  | 'pending'
  | 'accepted'
  | 'applied'
  | 'failed'
  | 'ambiguous'
  | 'cancelled'

export type InputResetPolicy = 'follow_latest' | 'expire_on_generation_change' | 'pin_generation'

export interface InputAdmissionRecord {
  inputAttemptId: string
  admissionKind: InputAdmissionKind
  intent: InputIntent
  originalResponse: Readonly<Record<string, unknown>>
  currentState?: Readonly<Record<string, unknown>> | undefined
  runId?: string | undefined
  inputApplicationId?: string | undefined
  queueItemId?: string | undefined
  status: string
  createdAt: string
  updatedAt: string
}

export interface InputQueueItem {
  queueItemId: string
  inputAttemptId: string
  runId: string
  scopeRef: string
  laneRef: string
  seq: number
  status: InputQueueStatus
  resetPolicy: InputResetPolicy
  expectedHostSessionId?: string | undefined
  expectedGeneration?: number | undefined
  notBeforeAt?: string | undefined
  leasedAt?: string | undefined
  leaseOwner?: string | undefined
  attempts: number
  lastErrorCode?: string | undefined
  lastErrorMessage?: string | undefined
  createdAt: string
  updatedAt: string
}

export interface InputApplication {
  inputApplicationId: string
  inputAttemptId: string
  targetRunId?: string | undefined
  hrcRunId?: string | undefined
  hostSessionId?: string | undefined
  generation?: number | undefined
  runtimeId?: string | undefined
  status: InputApplicationStatus
  deliveryAttempts: number
  lastErrorCode?: string | undefined
  lastErrorMessage?: string | undefined
  createdAt: string
  updatedAt: string
}
