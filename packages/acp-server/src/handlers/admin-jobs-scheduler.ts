import type { JobsStore } from 'acp-jobs-store'

import { json } from '../http.js'

import type { ResolvedAcpServerDeps } from '../deps.js'
import type { RouteHandler } from '../routing/route-context.js'

const DEFAULT_TICK_INTERVAL_MS = 5_000

function requireJobsStore(deps: ResolvedAcpServerDeps): JobsStore {
  if (deps.jobsStore === undefined) {
    throw new Error('jobs store is not configured')
  }

  return deps.jobsStore
}

function isEnabled(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true'
}

function readTickIntervalMs(): number {
  const raw = process.env['ACP_SCHEDULER_TICK_INTERVAL_MS']
  if (raw === undefined || raw.trim().length === 0) {
    return DEFAULT_TICK_INTERVAL_MS
  }

  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TICK_INTERVAL_MS
}

function readCount(value: unknown): number {
  if (typeof value !== 'object' || value === null || !('count' in value)) {
    return 0
  }

  const count = (value as { count: unknown }).count
  return typeof count === 'number' ? count : Number(count)
}

export const handleGetSchedulerState: RouteHandler = async ({ deps }) => {
  const jobsStore = requireJobsStore(deps)
  const now = new Date().toISOString()
  const dueCount = readCount(
    jobsStore.sqlite
      .prepare(
        `
          SELECT COUNT(*) AS count
          FROM jobs
          WHERE archived_at IS NULL
            AND disabled = 0
            AND next_fire_at IS NOT NULL
            AND next_fire_at <= ?
        `
      )
      .get(now)
  )
  const claimedCount = readCount(
    jobsStore.sqlite
      .prepare(
        `
          SELECT COUNT(*) AS count
          FROM job_runs
          WHERE status IN ('claimed', 'dispatched')
        `
      )
      .get()
  )

  return json({
    enabled: isEnabled(process.env['ACP_SCHEDULER_ENABLED']),
    tickIntervalMs: readTickIntervalMs(),
    dueCount,
    claimedCount,
    errors: [],
    identity: deps.jobNodeIdentityAuthority?.getDiagnostics() ?? {
      startupState: 'uninitialized',
      quiesced: false,
      lastFailure: {
        code: 'hrc_client_unavailable',
        message: 'job execution identity authority is not configured',
      },
    },
    note: 'lastTickAt and nextTickAt are not currently recorded by the scheduler.',
  })
}
