import { describe, expect, test } from 'bun:test'

import {
  getSummaryJobCron,
  getSummaryJobDisabled,
  getSummaryJobFlowStepCount,
  getSummaryJobId,
  getSummaryJobKind,
  getSummaryJobNextFireAt,
  getSummaryJobProjectId,
} from '../job-summary'

describe('job summary accessors', () => {
  test('reads shared job identity and summary fields with existing fallbacks', () => {
    const job = {
      job: {
        jobId: 'job-1',
        projectId: 'project-from-record',
        nextFireAt: 'not-a-date',
        disabled: true,
      },
      summary: {
        projectId: 'project-from-summary',
        kind: 'flow',
        nextFireAt: '',
        disabled: false,
        flowStepCount: 3,
      },
    }

    expect(getSummaryJobId(job)).toBe('job-1')
    expect(getSummaryJobProjectId(job)).toBe('project-from-summary')
    expect(getSummaryJobKind(job)).toBe('flow')
    expect(getSummaryJobNextFireAt(job)).toBe('None')
    expect(getSummaryJobDisabled(job)).toBe(false)
    expect(getSummaryJobFlowStepCount(job)).toBe(3)
  })

  test('preserves project cron fallback through record cron only when requested', () => {
    const job = {
      job: {
        cron: '0 7 * * *',
      },
      summary: {},
    }

    expect(getSummaryJobCron(job)).toBe('Manual')
    expect(getSummaryJobCron(job, { includeRecordCronFallback: true })).toBe('0 7 * * *')
  })

  test('prefers summary cron and schedule cron before optional record cron', () => {
    expect(
      getSummaryJobCron({
        job: { schedule: { cron: '0 8 * * *' }, cron: '0 9 * * *' },
        summary: { cron: '0 6 * * *' },
      })
    ).toBe('0 6 * * *')

    expect(
      getSummaryJobCron(
        {
          job: { schedule: { cron: '0 8 * * *' }, cron: '0 9 * * *' },
          summary: {},
        },
        { includeRecordCronFallback: true }
      )
    ).toBe('0 8 * * *')
  })
})
