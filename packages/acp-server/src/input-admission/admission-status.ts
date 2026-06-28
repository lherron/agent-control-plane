import type { InputQueueStatus, RunStatus } from 'acp-core'

export type DurableInputAdmissionStatus =
  | 'rejected'
  | 'queued'
  | 'pending'
  | 'accepted'
  | 'started'
  | 'failed'

export function admissionStatusForRunStatus(status: RunStatus): DurableInputAdmissionStatus {
  switch (status) {
    case 'queued':
      return 'queued'
    case 'pending':
      return 'pending'
    case 'running':
    case 'completed':
      return 'started'
    case 'failed':
    case 'cancelled':
      return 'failed'
  }
}

export function admissionStatusForQueueStatus(
  status: InputQueueStatus
): DurableInputAdmissionStatus {
  switch (status) {
    case 'queued':
      return 'queued'
    case 'leased':
    case 'dispatching':
      return 'accepted'
    case 'running':
    case 'completed':
      return 'started'
    case 'failed':
    case 'cancelled':
    case 'expired':
      return 'failed'
  }
}
