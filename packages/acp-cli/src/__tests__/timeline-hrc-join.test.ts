import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'

import { HrcStoreReader } from '../hrc-store-reader.js'
import type { GetTaskResponse } from '../http-client.js'
import { detectCollapsedHrcRuns, joinHrcTimeline } from '../output/timeline-hrc-join.js'
import { projectTaskTimeline } from '../output/timeline-project.js'
import { makeTimelineFixture } from './timeline-fixture.js'

const tempDirs: string[] = []

function makeStore(): string {
  const dir = mkdtempSync(join(tmpdir(), 'acp-hrc-join-'))
  tempDirs.push(dir)
  const path = join(dir, 'state.sqlite')
  const db = new Database(path)
  db.exec(`
    CREATE TABLE events (
      seq INTEGER PRIMARY KEY,
      ts TEXT NOT NULL,
      scope_ref TEXT NOT NULL,
      lane_ref TEXT NOT NULL,
      run_id TEXT,
      event_kind TEXT NOT NULL,
      event_json TEXT NOT NULL
    );
  `)
  const insert = db.prepare(
    'INSERT INTO events (seq, ts, scope_ref, lane_ref, run_id, event_kind, event_json) VALUES (?, ?, ?, ?, ?, ?, ?)'
  )
  insert.run(
    10,
    '2026-05-11T05:31:33.000Z',
    'cody@agent-spaces:T-TIMELINE',
    'main',
    'synthetic-run-id',
    'tool_execution_start',
    '{"toolName":"exec_command"}'
  )
  insert.run(
    11,
    '2026-05-11T05:31:34.000Z',
    'cody@agent-spaces:T-TIMELINE',
    'main',
    'synthetic-run-id',
    'tool_execution_end',
    '{"toolName":"exec_command"}'
  )
  insert.run(
    12,
    '2026-05-11T05:29:10.000Z',
    'agent:clod:project:agent-spaces',
    'main',
    'clod-main-run',
    'codex.user_prompt',
    '{"prompt":"create the SoD task"}'
  )
  insert.run(
    13,
    '2026-05-11T05:29:57.000Z',
    'agent:cody:project:agent-spaces',
    'main',
    'cody-main-run',
    'notice',
    '{"level":"info","message":"evidence attached"}'
  )
  db.close()
  return path
}

function makeRunlessTimelineFixture(): GetTaskResponse {
  const response = makeTimelineFixture()
  return {
    ...response,
    events: response.events.filter((event) => !event.type.startsWith('participant_run.')),
    participantRuns: [],
    workflowHrcRunMaps: [],
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('timeline HRC join', () => {
  test('falls back from run_id to scope+window and interleaves HRC rows', () => {
    const response = makeTimelineFixture()
    const reader = new HrcStoreReader(makeStore())
    const projection = joinHrcTimeline(projectTaskTimeline(response), {
      reader,
      response,
      detail: 'events',
    })
    reader.close()

    const runIndex = projection.rows.findIndex(
      (row) => row.ledger === 'acp' && row.type === 'participant_run.launched'
    )
    expect(projection.warnings).toContain('hrc_join_fallback:prun_1:scope+window')
    expect(projection.rows.slice(runIndex, runIndex + 3)).toEqual([
      expect.objectContaining({ ledger: 'acp', type: 'participant_run.launched' }),
      expect.objectContaining({
        ledger: 'hrc',
        hrcSeq: 10,
        eventKind: 'tool_execution_start',
        joinKind: 'scope_window',
      }),
      expect.objectContaining({
        ledger: 'hrc',
        hrcSeq: 11,
        eventKind: 'tool_execution_end',
        joinKind: 'scope_window',
      }),
    ])
  })

  test('collapses HRC rows in summary mode', () => {
    const response = makeTimelineFixture()
    const reader = new HrcStoreReader(makeStore())
    const projection = joinHrcTimeline(projectTaskTimeline(response), {
      reader,
      response,
      detail: 'summary',
    })
    reader.close()

    expect(projection.rows).toContainEqual(
      expect.objectContaining({
        ledger: 'hrc',
        eventKind: 'hrc.summary',
        summary: expect.objectContaining({ totalCount: 2 }),
      })
    )
  })

  test('auto anchors runless tasks on actor-bearing ACP events', () => {
    const response = makeRunlessTimelineFixture()
    const reader = new HrcStoreReader(makeStore())
    const projection = joinHrcTimeline(projectTaskTimeline(response), {
      reader,
      response,
      detail: 'events',
      anchorMode: 'auto',
      eventWindowSeconds: 30,
    })
    reader.close()

    const createdIndex = projection.rows.findIndex(
      (row) => row.ledger === 'acp' && row.type === 'task.created'
    )
    const evidenceIndex = projection.rows.findIndex(
      (row) => row.ledger === 'acp' && row.type === 'evidence.attached'
    )
    expect(projection.rows.slice(createdIndex, createdIndex + 2)).toEqual([
      expect.objectContaining({ ledger: 'acp', type: 'task.created' }),
      expect.objectContaining({
        ledger: 'hrc',
        parentParticipantRunId: 'event:1',
        hrcSeq: 12,
        eventKind: 'codex.user_prompt',
        joinKind: 'event_window',
      }),
    ])
    expect(projection.rows.slice(evidenceIndex, evidenceIndex + 2)).toEqual([
      expect.objectContaining({ ledger: 'acp', type: 'evidence.attached' }),
      expect.objectContaining({
        ledger: 'hrc',
        parentParticipantRunId: 'event:2',
        hrcSeq: 13,
        eventKind: 'notice',
        joinKind: 'event_window',
      }),
    ])
  })

  test('runs anchor mode does not attach HRC rows to runless tasks', () => {
    const response = makeRunlessTimelineFixture()
    const reader = new HrcStoreReader(makeStore())
    const projection = joinHrcTimeline(projectTaskTimeline(response), {
      reader,
      response,
      detail: 'events',
      anchorMode: 'runs',
    })
    reader.close()

    expect(projection.rows.some((row) => row.ledger === 'hrc')).toBe(false)
  })

  test('records repeated HRC tool rows for renderer collapse', () => {
    const rows = [
      { ledger: 'acp', type: 'participant_run.launched', category: 'run' },
      ...Array.from({ length: 5 }, (_, index) => ({
        ledger: 'hrc',
        parentParticipantRunId: 'prun_1',
        hrcSeq: 20 + index,
        eventKind: 'tool_execution_start',
        toolName: 'exec_command',
      })),
      {
        ledger: 'hrc',
        parentParticipantRunId: 'prun_1',
        hrcSeq: 30,
        eventKind: 'tool_execution_start',
        toolName: 'apply_patch',
      },
    ] as const

    expect(detectCollapsedHrcRuns(rows)).toEqual([
      {
        parentParticipantRunId: 'prun_1',
        start: 4,
        end: 5,
        count: 2,
        toolName: 'exec_command',
      },
    ])
  })
})
