import { formatActor, formatDateTime } from '@/lib/format'
import {
  getSummaryJobDisabled,
  getSummaryJobFlowStepCount,
  getSummaryJobId,
  getSummaryJobKind,
} from '@/lib/job-summary'
import type { ProjectJobSummary } from './types'

export { formatActor, formatDateTime }

export function formatBoolean(value: boolean | undefined): string {
  return value === true ? 'Yes' : 'No'
}

export function getJobId(job: ProjectJobSummary): string {
  return getSummaryJobId(job)
}

export function getJobAgentId(job: ProjectJobSummary): string {
  return job.job?.agentId ?? 'Unassigned'
}

export function getJobKind(job: ProjectJobSummary): string {
  return getSummaryJobKind(job)
}

export function getJobDisabled(job: ProjectJobSummary): boolean {
  return getSummaryJobDisabled(job)
}

export function getJobFlowStepCount(job: ProjectJobSummary): number {
  return getSummaryJobFlowStepCount(job)
}
