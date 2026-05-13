import { describe, expect, test } from 'bun:test'

import { projectTaskTimeline } from '../output/timeline-project.js'
import type { TaskTimelineProjection } from '../output/timeline-project.js'
import { renderTimeline } from '../output/timeline-render.js'
import { makeTimelineFixture } from './timeline-fixture.js'

describe('timeline rendering', () => {
  test('renders plain output without ansi escapes', () => {
    const text = renderTimeline(projectTaskTimeline(makeTimelineFixture()), {
      plain: true,
      color: false,
      width: 100,
    })

    expect(text).toContain('Task T-TIMELINE')
    expect(text).toContain('[x]   3 05:30:23')
    expect(text).toContain('version_conflict')
    expect(text).toContain('[*]   6 05:32:22')
    expect(text.includes(String.fromCharCode(27))).toBe(false)
  })

  test('renders markdown table output', () => {
    const text = renderTimeline(projectTaskTimeline(makeTimelineFixture()), {
      markdown: true,
      plain: false,
      color: false,
      width: 100,
    })

    expect(text).toContain('## Task T-TIMELINE · code_defect_fastlane@1')
    expect(text).toContain('| seq | time | event | actor | notes |')
    expect(text).toContain('❌ transition.rejected red_to_green')
  })

  test('renders repeated HRC tool collapse and assistant markdown blocks', () => {
    const projection: TaskTimelineProjection = {
      ...projectTaskTimeline(makeTimelineFixture()),
      hrcDetail: 'events',
      rows: [
        {
          ledger: 'hrc',
          parentParticipantRunId: 'prun_1',
          hrcSeq: 1,
          ts: '2026-05-11T05:31:34.000Z',
          eventKind: 'tool_execution_start',
          displayText: '💻 exec_command: pwd',
          toolName: 'exec_command',
          joinKind: 'run_id',
        },
        {
          ledger: 'hrc',
          parentParticipantRunId: 'prun_1',
          hrcSeq: 2,
          ts: '2026-05-11T05:31:35.000Z',
          eventKind: 'tool_execution_start',
          displayText: '💻 exec_command: ls',
          toolName: 'exec_command',
          joinKind: 'run_id',
        },
        {
          ledger: 'hrc',
          parentParticipantRunId: 'prun_1',
          hrcSeq: 3,
          ts: '2026-05-11T05:31:36.000Z',
          eventKind: 'tool_execution_start',
          displayText: '💻 exec_command: date',
          toolName: 'exec_command',
          joinKind: 'run_id',
        },
        {
          ledger: 'hrc',
          parentParticipantRunId: 'prun_1',
          hrcSeq: 4,
          ts: '2026-05-11T05:31:37.000Z',
          eventKind: 'tool_execution_start',
          displayText: '💻 exec_command: whoami',
          toolName: 'exec_command',
          joinKind: 'run_id',
        },
        {
          ledger: 'hrc',
          parentParticipantRunId: 'prun_1',
          hrcSeq: 5,
          ts: '2026-05-11T05:31:38.000Z',
          eventKind: 'message_end',
          displayText: '🤖 assistant',
          assistantBody: '## Done\n- first\n- second',
          joinKind: 'run_id',
        },
      ],
      collapsedRuns: [
        {
          parentParticipantRunId: 'prun_1',
          start: 3,
          end: 3,
          count: 1,
          toolName: 'exec_command',
        },
      ],
    }

    const text = renderTimeline(projection, {
      plain: true,
      color: false,
      width: 100,
    })

    expect(text).toContain('💻 exec_command: pwd')
    expect(text).toContain('… 1 more exec_command call')
    expect(text).toContain('🤖 assistant')
    expect(text).toContain('      > ## Done')
    expect(text).toContain('      > • first')
  })
})
