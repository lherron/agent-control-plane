import type { ParticipantRef } from './participant-ref.js'

export type LocalDispatchAttempt = {
  attemptId: string
  wakeId?: string | undefined
  target: ParticipantRef
  state: string
  createdAt: string
  updatedAt: string
}
