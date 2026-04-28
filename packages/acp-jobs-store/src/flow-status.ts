import type { JobRunRecord } from './open-store.js'

export type FlowJobRunResponseStatus = 'queued' | 'running' | 'succeeded' | 'failed'

export function mapJobRunStatusForFlowResponse(
  record: Pick<JobRunRecord, 'status'>
): FlowJobRunResponseStatus {
  switch (record.status) {
    case 'pending':
      return 'queued'
    case 'claimed':
    case 'dispatched':
      return 'running'
    case 'succeeded':
      return 'succeeded'
    case 'failed':
      return 'failed'
    case 'skipped':
      return 'failed'
  }
}
