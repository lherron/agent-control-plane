import type { Actor } from './actor.js'

export type RunStatus = 'queued' | 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface Run {
  runId: string
  scopeRef: string
  laneRef: string
  taskId?: string | undefined
  actor: Actor
  status: RunStatus
  createdAt: string
  completedAt?: string | undefined
  metadata?: Readonly<Record<string, unknown>> | undefined
}
