import { formatDateTime } from './format'

export type JobSummaryAccessorInput = {
  job?:
    | {
        jobId?: string | undefined
        projectId?: string | undefined
        schedule?: { cron?: string | undefined } | undefined
        cron?: string | null | undefined
        nextFireAt?: string | null | undefined
        disabled?: boolean | undefined
      }
    | undefined
  summary?:
    | {
        projectId?: string | undefined
        kind?: string | undefined
        cron?: string | null | undefined
        nextFireAt?: string | null | undefined
        disabled?: boolean | undefined
        flowStepCount?: number | undefined
      }
    | undefined
}

export function getSummaryJobId(job: JobSummaryAccessorInput): string {
  return job.job?.jobId ?? 'unknown'
}

export function getSummaryJobProjectId(job: JobSummaryAccessorInput): string {
  return job.summary?.projectId ?? job.job?.projectId ?? 'Unknown'
}

export function getSummaryJobKind(job: JobSummaryAccessorInput): string {
  return job.summary?.kind ?? 'unknown'
}

export function getSummaryJobCron(
  job: JobSummaryAccessorInput,
  options: { includeRecordCronFallback?: boolean | undefined } = {}
): string {
  return (
    job.summary?.cron ??
    job.job?.schedule?.cron ??
    (options.includeRecordCronFallback === true ? job.job?.cron : undefined) ??
    'Manual'
  )
}

export function getSummaryJobNextFireAt(job: JobSummaryAccessorInput): string {
  return formatDateTime(job.summary?.nextFireAt ?? job.job?.nextFireAt)
}

export function getSummaryJobDisabled(job: JobSummaryAccessorInput): boolean {
  return job.summary?.disabled ?? job.job?.disabled ?? false
}

export function getSummaryJobFlowStepCount(job: JobSummaryAccessorInput): number {
  return job.summary?.flowStepCount ?? 0
}
