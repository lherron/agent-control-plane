import { describe, expect, test } from 'bun:test'

import {
  getSummaryJobDisabled,
  getSummaryJobFlowStepCount,
  getSummaryJobId,
  getSummaryJobKind,
  getSummaryJobProjectId,
} from '../job-summary'

describe('job summary accessors', () => {
  test('reads shared job identity and summary fields with existing fallbacks', () => {
    const job = {
      job: {
        jobId: 'job-1',
        projectId: 'project-from-record',
        disabled: true,
      },
      summary: {
        projectId: 'project-from-summary',
        kind: 'flow',
        disabled: false,
        flowStepCount: 3,
      },
    }

    expect(getSummaryJobId(job)).toBe('job-1')
    expect(getSummaryJobProjectId(job)).toBe('project-from-summary')
    expect(getSummaryJobKind(job)).toBe('flow')
    expect(getSummaryJobDisabled(job)).toBe(false)
    expect(getSummaryJobFlowStepCount(job)).toBe(3)
  })
})
