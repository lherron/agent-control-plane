import type {
  JobExecutionAdmissionFailureCode,
  JobExecutionIdentity,
  JobRecord,
} from './store-contracts.js'

export class JobExecutionAdmissionError extends Error {
  readonly code: JobExecutionAdmissionFailureCode
  readonly jobId: string
  readonly ownerSet: readonly string[] | undefined
  readonly currentNode: string

  constructor(input: {
    code: JobExecutionAdmissionFailureCode
    job: JobRecord
    identity: JobExecutionIdentity
    message: string
  }) {
    super(input.message)
    this.name = 'JobExecutionAdmissionError'
    this.code = input.code
    this.jobId = input.job.jobId
    this.ownerSet = input.job.executionNodes
    this.currentNode = input.identity.nodeId
  }
}

export function assertJobExecutionAdmission(job: JobRecord, identity: JobExecutionIdentity): void {
  if (job.archivedAt !== undefined) {
    throw new JobExecutionAdmissionError({
      code: 'job_execution_archived',
      job,
      identity,
      message: `job ${job.jobId} is archived`,
    })
  }
  if (job.disabled) {
    throw new JobExecutionAdmissionError({
      code: 'job_execution_disabled',
      job,
      identity,
      message: `job ${job.jobId} is disabled`,
    })
  }
  // Event-hook placement is node-local: event runs mint on whichever node
  // receives the event, with no owner-set check (execution-status reports
  // event_hook_placement_not_supported). A manual run of an event job follows
  // the same rule and runs on the node that received the request (T-10378).
  if (job.trigger.kind === 'event') {
    return
  }
  const ownerSet = job.executionNodes
  if (ownerSet === undefined) {
    if (identity.mode === 'single-node') {
      return
    }
    throw new JobExecutionAdmissionError({
      code: 'job_execution_unassigned_federated',
      job,
      identity,
      message: `job ${job.jobId} has no execution owner set in federated mode`,
    })
  }
  if (ownerSet.includes('all') || ownerSet.includes(identity.nodeId)) {
    return
  }
  throw new JobExecutionAdmissionError({
    code: 'job_execution_wrong_node',
    job,
    identity,
    message: `job ${job.jobId} is not owned by node ${identity.nodeId}`,
  })
}

export function normalizeExecutionNodes(
  value: readonly string[] | undefined
): readonly string[] | undefined {
  if (value === undefined) return undefined
  if (value.length === 0) {
    throw new Error('executionNodes must contain at least one node id')
  }
  if (
    value.some(
      (nodeId) =>
        typeof nodeId !== 'string' ||
        nodeId === 'local' ||
        (nodeId !== 'all' && !/^[A-Za-z0-9._-]{1,64}$/.test(nodeId))
    )
  ) {
    throw new Error('executionNodes contains an invalid or reserved node id')
  }
  const normalized = [...new Set(value)].sort()
  if (normalized.includes('all') && normalized.length !== 1) {
    throw new Error('executionNodes cannot mix "all" with concrete node ids')
  }
  return normalized
}

export function parseExecutionNodesJson(value: string): readonly string[] {
  const parsed = JSON.parse(value) as unknown
  if (!Array.isArray(parsed) || parsed.some((nodeId) => typeof nodeId !== 'string')) {
    throw new Error('stored executionNodes is invalid')
  }
  const normalized = normalizeExecutionNodes(parsed)
  if (normalized === undefined) {
    throw new Error('stored executionNodes is invalid')
  }
  return normalized
}
