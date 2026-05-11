import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'

import { HrcStoreReader } from '../hrc-store-reader.js'

const tempDirs: string[] = []

function makeStore(): string {
  const dir = mkdtempSync(join(tmpdir(), 'acp-hrc-reader-'))
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
    1,
    '2026-05-11T05:31:33.000Z',
    'cody@agent-spaces:T-TIMELINE',
    'main',
    'hrc-run-1',
    'codex.websocket_event',
    '{}'
  )
  insert.run(
    2,
    '2026-05-11T05:31:34.000Z',
    'cody@agent-spaces:T-TIMELINE',
    'main',
    'hrc-run-1',
    'tool_execution_start',
    '{"toolName":"exec_command"}'
  )
  insert.run(
    3,
    '2026-05-11T05:31:34.100Z',
    'cody@agent-spaces:T-TIMELINE',
    'main',
    'hrc-run-1',
    'message_start',
    '{"messageId":"msg_1"}'
  )
  insert.run(
    4,
    '2026-05-11T05:31:34.200Z',
    'cody@agent-spaces:T-TIMELINE',
    'main',
    'hrc-run-1',
    'message_update',
    '{"messageId":"msg_1","textDelta":"tok"}'
  )
  insert.run(
    5,
    '2026-05-11T05:31:34.300Z',
    'cody@agent-spaces:T-TIMELINE',
    'main',
    'hrc-run-1',
    'tool_execution_update',
    '{"toolName":"exec_command","textDelta":"stdout chunk"}'
  )
  insert.run(
    6,
    '2026-05-11T05:31:35.000Z',
    'cody@agent-spaces:T-TIMELINE',
    'main',
    'hrc-run-1',
    'tool_execution_end',
    '{"toolName":"exec_command","isError":false}'
  )
  db.close()
  return path
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('HrcStoreReader', () => {
  test('reads events by run id and excludes transport noise by default', () => {
    const reader = new HrcStoreReader(makeStore())
    const result = reader.fetchByRunId({
      hrcRunId: 'hrc-run-1',
      fromTs: '2026-05-11T05:31:32.000Z',
      toTs: '2026-05-11T05:31:36.000Z',
    })
    reader.close()

    expect(result.totalCount).toBe(2)
    expect(result.events.map((event) => event.eventKind)).toEqual([
      'tool_execution_start',
      'tool_execution_end',
    ])
  })

  test('excludes streaming deltas by default but keeps them requestable', () => {
    const reader = new HrcStoreReader(makeStore())
    const defaultResult = reader.fetchByRunId({
      hrcRunId: 'hrc-run-1',
      fromTs: '2026-05-11T05:31:32.000Z',
      toTs: '2026-05-11T05:31:36.000Z',
    })
    const explicitResult = reader.fetchByRunId({
      hrcRunId: 'hrc-run-1',
      fromTs: '2026-05-11T05:31:32.000Z',
      toTs: '2026-05-11T05:31:36.000Z',
      kinds: new Set(['message_update', 'tool_execution_update']),
    })
    const allKindsResult = reader.fetchByRunId({
      hrcRunId: 'hrc-run-1',
      fromTs: '2026-05-11T05:31:32.000Z',
      toTs: '2026-05-11T05:31:36.000Z',
      allKinds: true,
    })
    reader.close()

    expect(defaultResult.events.map((event) => event.eventKind)).not.toContain('message_update')
    expect(defaultResult.events.map((event) => event.eventKind)).not.toContain(
      'tool_execution_update'
    )
    expect(explicitResult.events.map((event) => event.eventKind)).toEqual([
      'message_update',
      'tool_execution_update',
    ])
    expect(allKindsResult.totalCount).toBe(6)
  })

  test('applies a positive event-kind filter', () => {
    const reader = new HrcStoreReader(makeStore())
    const result = reader.fetchByScopeWindow({
      scopeRef: 'cody@agent-spaces:T-TIMELINE',
      laneRef: 'main',
      fromTs: '2026-05-11T05:31:32.000Z',
      toTs: '2026-05-11T05:31:36.000Z',
      kinds: new Set(['tool_execution_end']),
    })
    reader.close()

    expect(result.totalCount).toBe(1)
    expect(result.events[0]).toMatchObject({
      hrcSeq: 6,
      eventKind: 'tool_execution_end',
    })
  })

  test('applies wildcard event-kind filters', () => {
    const reader = new HrcStoreReader(makeStore())
    const result = reader.fetchByRunId({
      hrcRunId: 'hrc-run-1',
      fromTs: '2026-05-11T05:31:32.000Z',
      toTs: '2026-05-11T05:31:36.000Z',
      kinds: new Set(['tool_execution_*']),
    })
    reader.close()

    expect(result.totalCount).toBe(3)
    expect(result.events.map((event) => event.eventKind)).toEqual([
      'tool_execution_start',
      'tool_execution_update',
      'tool_execution_end',
    ])
  })
})
