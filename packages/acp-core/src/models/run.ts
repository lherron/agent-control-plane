export interface Run {
  runId: string
  scopeRef: string
  laneRef: string
  taskId?: string | undefined
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  createdAt: string
  completedAt?: string | undefined
  metadata?: Readonly<Record<string, unknown>> | undefined
}
