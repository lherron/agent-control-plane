import type { SessionRef } from 'agent-scope'

import type { DeliveryTarget } from '../interface/delivery-target.js'

export type Job = {
  jobId: string
  sessionRef: SessionRef
  enabled: boolean
  createdAt: string
  updatedAt: string
  deliveryTarget?: DeliveryTarget | undefined
  metadata?: Readonly<Record<string, unknown>> | undefined
}

export type JobRunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

export type JobRun = {
  jobRunId: string
  jobId: string
  status: JobRunStatus
  scheduledFor?: string | undefined
  startedAt?: string | undefined
  completedAt?: string | undefined
  inputAttemptId?: string | undefined
  runId?: string | undefined
  errorCode?: string | undefined
  errorMessage?: string | undefined
  metadata?: Readonly<Record<string, unknown>> | undefined
}
