export type JobSummaryAccessorInput = {
  job?:
    | {
        jobId?: string | undefined
        projectId?: string | undefined
        disabled?: boolean | undefined
      }
    | undefined
  summary?:
    | {
        projectId?: string | undefined
        kind?: string | undefined
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

export function getSummaryJobDisabled(job: JobSummaryAccessorInput): boolean {
  return job.summary?.disabled ?? job.job?.disabled ?? false
}

export function getSummaryJobFlowStepCount(job: JobSummaryAccessorInput): number {
  return job.summary?.flowStepCount ?? 0
}
