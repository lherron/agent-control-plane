import type { SessionRef } from 'agent-scope'

export const WAKE_STATE = {
  queued: 'queued',
  leased: 'leased',
  consumed: 'consumed',
  cancelled: 'cancelled',
  expired: 'expired',
} as const

export type WakeRequestState = (typeof WAKE_STATE)[keyof typeof WAKE_STATE]

export type WakeRequest = {
  wakeId: string
  projectId: string
  sourceEventId: string
  sessionRef: SessionRef
  reason?: string | undefined
  dedupeKey?: string | undefined
  state: WakeRequestState
  leasedUntil?: string | undefined
  createdAt: string
  updatedAt: string
}

export type WakeRequestInput = Omit<
  WakeRequest,
  'wakeId' | 'projectId' | 'sourceEventId' | 'createdAt' | 'updatedAt' | 'state' | 'leasedUntil'
> & {
  state?: WakeRequestState | undefined
  leasedUntil?: string | undefined
}
