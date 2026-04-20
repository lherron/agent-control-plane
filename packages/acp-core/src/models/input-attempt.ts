export interface InputAttempt {
  inputAttemptId: string
  scopeRef: string
  laneRef: string
  taskId?: string | undefined
  idempotencyKey?: string | undefined
  createdAt: string
  metadata?: Readonly<Record<string, unknown>> | undefined
}
