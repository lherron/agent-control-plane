export {}

declare global {
  interface JobSummary {
    jobId: string
    projectId: string
    name?: string | undefined
    kind?: string | undefined
    disabled?: boolean | undefined
    cron?: string | null | undefined
    nextFireAt?: string | null | undefined
    flowStepCount?: number | undefined
    createdAt?: string | undefined
    updatedAt?: string | undefined
  }
}
