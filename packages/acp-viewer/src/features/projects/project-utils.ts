import { formatActor, formatDateTime } from '@/lib/format'
import type { ProjectJobSummary } from './types'

export { formatActor, formatDateTime }

export function formatBoolean(value: boolean | undefined): string {
  return value === true ? 'Yes' : 'No'
}

export function getJobId(job: ProjectJobSummary): string {
  return job.job?.jobId ?? 'unknown'
}

export function getJobAgentId(job: ProjectJobSummary): string {
  return job.job?.agentId ?? 'Unassigned'
}

export function getJobKind(job: ProjectJobSummary): string {
  return job.summary?.kind ?? 'unknown'
}

export function getJobCron(job: ProjectJobSummary): string {
  return job.summary?.cron ?? job.job?.schedule?.cron ?? job.job?.cron ?? 'Manual'
}

export function getJobNextFireAt(job: ProjectJobSummary): string {
  return formatDateTime(job.summary?.nextFireAt ?? job.job?.nextFireAt)
}

export function getJobDisabled(job: ProjectJobSummary): boolean {
  return job.summary?.disabled ?? job.job?.disabled ?? false
}

export function getJobFlowStepCount(job: ProjectJobSummary): number {
  return job.summary?.flowStepCount ?? 0
}
