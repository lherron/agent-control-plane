import { formatActor, formatDateTime } from '@/lib/format'
import type { AgentHeartbeat, AgentJobSummary } from './types'

export { formatActor, formatDateTime }

export function heartbeatStatus(heartbeat: AgentHeartbeat | null | undefined): string {
  if (heartbeat === undefined || heartbeat === null) {
    return 'stale'
  }

  return heartbeat.status
}

export function getJobId(job: AgentJobSummary): string {
  return job.job?.jobId ?? 'unknown'
}

export function getJobProjectId(job: AgentJobSummary): string {
  return job.summary?.projectId ?? job.job?.projectId ?? 'Unknown'
}

export function getJobKind(job: AgentJobSummary): string {
  return job.summary?.kind ?? 'unknown'
}

export function getJobCron(job: AgentJobSummary): string {
  return job.summary?.cron ?? job.job?.schedule?.cron ?? 'Manual'
}

export function getJobNextFireAt(job: AgentJobSummary): string {
  return formatDateTime(job.summary?.nextFireAt ?? job.job?.nextFireAt)
}

export function getJobFlowStepCount(job: AgentJobSummary): number {
  return job.summary?.flowStepCount ?? 0
}
