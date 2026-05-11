import type { ProjectJobSummary } from './types'

export function formatActor(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }

  if (typeof value === 'object' && value !== null) {
    const actor = value as { kind?: unknown; id?: unknown }
    const kind = typeof actor.kind === 'string' ? actor.kind : 'actor'
    const id = typeof actor.id === 'string' ? actor.id : undefined
    return id === undefined ? kind : `${kind}:${id}`
  }

  return 'Unknown'
}

export function formatDateTime(value: string | null | undefined): string {
  if (value === undefined || value === null || value.length === 0) {
    return 'None'
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}

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
