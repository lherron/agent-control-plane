import type { Actor } from './actor.js'

export interface InputAttempt {
  inputAttemptId: string
  scopeRef: string
  laneRef: string
  taskId?: string | undefined
  idempotencyKey?: string | undefined
  actor: Actor
  createdAt: string
  metadata?: Readonly<Record<string, unknown>> | undefined
}
