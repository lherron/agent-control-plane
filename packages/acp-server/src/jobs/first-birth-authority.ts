import type { JobsStore } from 'acp-jobs-store'
import { type SessionRef, normalizeSessionRef } from 'agent-scope'

/**
 * Decides whether a launch that claims job provenance may first-birth an
 * unbound scope (T-09993). Caller meta on /v1/inputs is not trusted: the
 * claimed jobRunId must name a live run in the jobs store whose own target is
 * exactly this session.
 */
export type JobFirstBirthAuthority = (input: {
  jobRunId: string
  sessionRef: SessionRef
}) => 'input-only' | 'other-job' | undefined

const LIVE_JOB_RUN_STATUSES = new Set(['claimed', 'dispatched'])

export function createJobFirstBirthAuthority(
  jobsStore: Pick<JobsStore, 'getJob' | 'getJobRun'>
): JobFirstBirthAuthority {
  return ({ jobRunId, sessionRef }) => {
    const jobRun = jobsStore.getJobRun(jobRunId).jobRun
    if (jobRun === undefined || !LIVE_JOB_RUN_STATUSES.has(jobRun.status)) {
      return undefined
    }
    const job = jobsStore.getJob(jobRun.jobId).job
    const scopeRef = jobRun.resolvedScopeRef ?? job?.scopeRef
    if (scopeRef === undefined) {
      return undefined
    }
    try {
      const target = normalizeSessionRef({
        scopeRef,
        laneRef: jobRun.resolvedLaneRef ?? job?.laneRef ?? 'main',
      })
      const launched = normalizeSessionRef(sessionRef)
      if (target.scopeRef !== launched.scopeRef || target.laneRef !== launched.laneRef) {
        return undefined
      }
      return job !== undefined && job.flow === undefined ? 'input-only' : 'other-job'
    } catch {
      // An unresolved template or malformed ref is never this session.
      return undefined
    }
  }
}
