import type { AgentHeartbeat, AgentJobSummary } from './types'

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
