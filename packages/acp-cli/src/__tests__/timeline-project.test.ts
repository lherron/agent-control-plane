import { describe, expect, test } from 'bun:test'

import { projectTaskTimeline } from '../output/timeline-project.js'
import { makeTimelineFixture } from './timeline-fixture.js'

describe('timeline projection', () => {
  test('projects workflow events into ordered timeline rows with enrichment', () => {
    const projection = projectTaskTimeline(makeTimelineFixture())

    expect(projection.summary).toMatchObject({ eventCount: 6, rejectionCount: 1 })
    expect(projection.rows.map((row) => [row.seq, row.category, row.kind, row.type])).toEqual([
      [1, 'meta', 'accepted', 'task.created'],
      [2, 'evidence', 'evidence', 'evidence.attached'],
      [3, 'transition', 'rejected', 'transition.rejected'],
      [4, 'transition', 'accepted', 'transition.applied'],
      [5, 'run', 'run', 'participant_run.launched'],
      [6, 'mapping', 'mapping', 'workflow_hrc_run.mapped'],
    ])
    expect(projection.rows[2]).toMatchObject({ rejectionCode: 'version_conflict' })
    expect(projection.rows[3]).toMatchObject({ versionDelta: { from: 0, to: 1 } })
    expect(projection.rows[5]).toMatchObject({
      scopeRef: 'cody@agent-spaces:T-TIMELINE',
      refs: expect.arrayContaining(['hrc-run-1', 'scope:cody@agent-spaces:T-TIMELINE']),
    })
  })
})
