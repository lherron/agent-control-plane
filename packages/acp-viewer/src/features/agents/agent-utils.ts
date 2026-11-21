import { formatActor, formatDateTime } from '@/lib/format'
import {
  getSummaryJobFlowStepCount,
  getSummaryJobId,
  getSummaryJobKind,
  getSummaryJobProjectId,
} from '@/lib/job-summary'
import type { AgentHeartbeat, AgentJobSummary } from './types'

export { formatActor, formatDateTime }

export function heartbeatStatus(heartbeat: AgentHeartbeat | null | undefined): string {
  if (heartbeat === undefined || heartbeat === null) {
    return 'stale'
  }

  return heartbeat.status
}

export function getJobId(job: AgentJobSummary): string {
  return getSummaryJobId(job)
}

export function getJobProjectId(job: AgentJobSummary): string {
  return getSummaryJobProjectId(job)
}

export function getJobKind(job: AgentJobSummary): string {
  return getSummaryJobKind(job)
}

export function getJobFlowStepCount(job: AgentJobSummary): number {
  return getSummaryJobFlowStepCount(job)
}
