import type { JobRecord, JobsStore } from 'acp-jobs-store'

import type { JobNodeIdentityDiagnostics } from './node-identity.js'

export type JobExecutionStatus = Readonly<{
  currentNode?: string | undefined
  mode?: 'single-node' | 'federated' | undefined
  ownerSet?: readonly string[] | undefined
  effectiveOwnerSet?: readonly string[] | undefined
  eligible: boolean
  eligibilityReason:
    | 'eligible'
    | 'disabled'
    | 'identity_unavailable'
    | 'identity_quiesced'
    | 'unassigned_federated'
    | 'wrong_node'
    | 'event_hook_placement_not_supported'
  inflightCount: number
  localInflightCount?: number | undefined
  ownedButIncapable: readonly ('scheduler_disabled' | 'exec_disabled')[]
}>

function readCount(value: unknown): number {
  if (typeof value !== 'object' || value === null || !('count' in value)) {
    return 0
  }
  const count = (value as { count: unknown }).count
  return typeof count === 'number' ? count : Number(count)
}

function containsExecStep(job: JobRecord): boolean {
  return [...(job.flow?.sequence ?? []), ...(job.flow?.onFailure ?? [])].some(
    (step) => step.kind === 'exec'
  )
}

export function getJobExecutionStatus(input: {
  jobsStore: JobsStore
  job: JobRecord
  identity: JobNodeIdentityDiagnostics
  schedulerEnabled: boolean
  execEnabled: boolean
}): JobExecutionStatus {
  const current = input.identity.current ?? input.identity.baseline
  const inflightCount = readCount(
    input.jobsStore.sqlite
      .prepare(
        `
          SELECT COUNT(*) AS count
          FROM job_runs
          WHERE job_id = ?
            AND status IN ('pending', 'claimed', 'dispatched')
        `
      )
      .get(input.job.jobId)
  )
  const localInflightCount =
    current === undefined
      ? undefined
      : readCount(
          input.jobsStore.sqlite
            .prepare(
              `
                SELECT COUNT(*) AS count
                FROM job_runs
                WHERE job_id = ?
                  AND execution_node_id = ?
                  AND status IN ('pending', 'claimed', 'dispatched')
              `
            )
            .get(input.job.jobId, current.nodeId)
        )

  let eligible = false
  let eligibilityReason: JobExecutionStatus['eligibilityReason']
  let effectiveOwnerSet: readonly string[] | undefined
  if (input.job.trigger.kind === 'event') {
    eligibilityReason = 'event_hook_placement_not_supported'
  } else if (input.job.disabled) {
    eligibilityReason = 'disabled'
  } else if (input.identity.quiesced) {
    eligibilityReason = 'identity_quiesced'
  } else if (input.identity.startupState !== 'ready' || current === undefined) {
    eligibilityReason = 'identity_unavailable'
  } else if (input.job.executionNodes === undefined) {
    if (current.mode === 'single-node') {
      eligible = true
      eligibilityReason = 'eligible'
      effectiveOwnerSet = [current.nodeId]
    } else {
      eligibilityReason = 'unassigned_federated'
    }
  } else {
    effectiveOwnerSet = input.job.executionNodes
    eligible =
      input.job.executionNodes.includes('all') || input.job.executionNodes.includes(current.nodeId)
    eligibilityReason = eligible ? 'eligible' : 'wrong_node'
  }

  const ownedButIncapable: Array<'scheduler_disabled' | 'exec_disabled'> = []
  if (eligible && !input.schedulerEnabled) {
    ownedButIncapable.push('scheduler_disabled')
  }
  if (eligible && containsExecStep(input.job) && !input.execEnabled) {
    ownedButIncapable.push('exec_disabled')
  }

  return {
    ...(current !== undefined ? { currentNode: current.nodeId, mode: current.mode } : {}),
    ...(input.job.executionNodes !== undefined ? { ownerSet: input.job.executionNodes } : {}),
    ...(effectiveOwnerSet !== undefined ? { effectiveOwnerSet } : {}),
    eligible,
    eligibilityReason,
    inflightCount,
    ...(localInflightCount !== undefined ? { localInflightCount } : {}),
    ownedButIncapable,
  }
}
