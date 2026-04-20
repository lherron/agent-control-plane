export interface Session {
  sessionId: string
  scopeRef: string
  laneRef: string
  taskId?: string | undefined
  role?: string | undefined
  state: 'active' | 'idle' | 'closed'
  createdAt: string
  updatedAt: string
}
