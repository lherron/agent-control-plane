import type { SessionRef } from 'agent-scope'

export type WakeRequestState = 'queued' | 'leased' | 'consumed' | 'cancelled' | 'expired'

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
