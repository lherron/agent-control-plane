import type { Actor } from './actor.js'

export interface Run {
  runId: string
  scopeRef: string
  laneRef: string
  taskId?: string | undefined
  actor: Actor
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  createdAt: string
  completedAt?: string | undefined
  metadata?: Readonly<Record<string, unknown>> | undefined
}
