import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'

import type { UnifiedSessionEvent } from 'spaces-runtime'

import type { StoredRun } from '../../src/domain/run-store.js'
import {
  type HrcEventReaders,
  type RunFinalOutputDeps,
  getRunFinalAssistantText,
} from '../../src/jobs/run-final-output.js'
import { readCompletedAssistantMessageFromHrcEvents } from '../../src/real-launcher.js'

const tempDirs: string[] = []

// ---------------------------------------------------------------------------
// Helpers: minimal StoredRun factory
// ---------------------------------------------------------------------------

function makeRun(overrides: Partial<StoredRun> = {}): StoredRun {
  return {
    runId: 'run-1',
    scopeRef: 'agent:larry@project:demo',
    laneRef: 'main',
    actor: { kind: 'system', id: 'test' },
    status: 'completed',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

function makeDeps(run: StoredRun | undefined, hrcDbPath = ':memory:'): RunFinalOutputDeps {
  return {
    getRun: () => run,
    hrcDbPath,
  }
}

function makeStore(): string {
  const dir = mkdtempSync(join(tmpdir(), 'acp-run-final-output-'))
  tempDirs.push(dir)
  const path = join(dir, 'state.sqlite')
  const db = new Database(path)
  db.exec(`
    CREATE TABLE events (
      seq INTEGER PRIMARY KEY,
      run_id TEXT,
      event_kind TEXT NOT NULL,
      event_json TEXT NOT NULL
    );

    CREATE TABLE hrc_events (
      hrc_seq INTEGER PRIMARY KEY,
      run_id TEXT,
      event_kind TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
  `)
  db.close()
  return path
}

// ---------------------------------------------------------------------------
// Fake readers
// ---------------------------------------------------------------------------

function fakeReaders(overrides: Partial<HrcEventReaders> = {}): HrcEventReaders {
  return {
    readCompletedAssistantMessageFromHrcEvents: () => undefined,
    readLatestAssistantMessageSeq: () => 0,
    readAssistantMessageAfterSeq: () => undefined,
    ...overrides,
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function makeMessageEndEvent(text: string): UnifiedSessionEvent {
  return {
    type: 'message_end',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getRunFinalAssistantText', () => {
  // -----------------------------------------------------------------------
  // Headless path (hrcRunId)
  // -----------------------------------------------------------------------

  test('headless: extracts text from hrc_events via hrcRunId', () => {
    const run = makeRun({ hrcRunId: 'hrc-run-42' })
    const deps = makeDeps(run, '/fake/hrc.db')

    const readers = fakeReaders({
      readCompletedAssistantMessageFromHrcEvents: (dbPath, runId) => {
        expect(dbPath).toBe('/fake/hrc.db')
        expect(runId).toBe('hrc-run-42')
        return makeMessageEndEvent('headless reply')
      },
    })

    const result = getRunFinalAssistantText(deps, 'run-1', readers)
    expect(result).toBe('headless reply')
  })

  test('headless: returns undefined when no events exist', () => {
    const run = makeRun({ hrcRunId: 'hrc-run-empty' })
    const deps = makeDeps(run)

    const result = getRunFinalAssistantText(deps, 'run-1', fakeReaders())
    expect(result).toBeUndefined()
  })

  test('headless: reads final output from canonical hrc_events', () => {
    const path = makeStore()
    const db = new Database(path)
    db.prepare(
      `INSERT INTO events (seq, run_id, event_kind, event_json)
        VALUES (?, ?, ?, ?)`
    ).run(
      1,
      'hrc-run-canonical',
      'sdk.message_delta',
      JSON.stringify({ type: 'message_delta', role: 'assistant', delta: 'raw-only reply' })
    )
    db.prepare(
      `INSERT INTO hrc_events (hrc_seq, run_id, event_kind, payload_json)
        VALUES (?, ?, ?, ?)`
    ).run(
      1,
      'hrc-run-canonical',
      'turn.completed',
      JSON.stringify({ finalOutput: 'canonical reply' })
    )
    db.close()

    const run = makeRun({ hrcRunId: 'hrc-run-canonical' })
    const result = getRunFinalAssistantText(makeDeps(run, path), 'run-1')
    expect(result).toBe('canonical reply')
  })

  test('headless: ignores raw events when hrc_events has no final output', () => {
    const path = makeStore()
    const db = new Database(path)
    db.prepare(
      `INSERT INTO events (seq, run_id, event_kind, event_json)
        VALUES (?, ?, ?, ?)`
    ).run(
      1,
      'hrc-run-raw-only',
      'sdk.message_delta',
      JSON.stringify({ type: 'message_delta', role: 'assistant', delta: 'raw-only reply' })
    )
    db.close()

    const run = makeRun({ hrcRunId: 'hrc-run-raw-only' })
    const result = getRunFinalAssistantText(makeDeps(run, path), 'run-1')
    expect(result).toBeUndefined()
  })

  // -----------------------------------------------------------------------
  // Interactive/tmux path (hostSessionId)
  // -----------------------------------------------------------------------

  test('interactive: extracts text from hrc_events via hostSessionId', () => {
    const run = makeRun({
      hostSessionId: 'hsid-789',
      generation: 5,
    })
    const deps = makeDeps(run, '/fake/hrc.db')

    const readers = fakeReaders({
      readLatestAssistantMessageSeq: (dbPath, input) => {
        expect(dbPath).toBe('/fake/hrc.db')
        expect(input.hostSessionId).toBe('hsid-789')
        expect(input.sessionRef.scopeRef).toBe('agent:larry@project:demo')
        expect(input.sessionRef.laneRef).toBe('main')
        return 10
      },
      readAssistantMessageAfterSeq: (options) => {
        expect(options.hrcDbPath).toBe('/fake/hrc.db')
        expect(options.hostSessionId).toBe('hsid-789')
        expect(options.afterHrcSeq).toBe(9) // latestSeq - 1
        return makeMessageEndEvent('interactive reply')
      },
    })

    const result = getRunFinalAssistantText(deps, 'run-1', readers)
    expect(result).toBe('interactive reply')
  })

  test('interactive: returns undefined when latestSeq is 0 (no messages)', () => {
    const run = makeRun({
      hostSessionId: 'hsid-empty',
      generation: 1,
    })
    const deps = makeDeps(run)

    const readers = fakeReaders({
      readLatestAssistantMessageSeq: () => 0,
    })

    const result = getRunFinalAssistantText(deps, 'run-1', readers)
    expect(result).toBeUndefined()
  })

  test('interactive: returns undefined when readAssistantMessageAfterSeq returns undefined', () => {
    const run = makeRun({
      hostSessionId: 'hsid-gap',
      generation: 2,
    })
    const deps = makeDeps(run)

    const readers = fakeReaders({
      readLatestAssistantMessageSeq: () => 5,
      readAssistantMessageAfterSeq: () => undefined,
    })

    const result = getRunFinalAssistantText(deps, 'run-1', readers)
    expect(result).toBeUndefined()
  })

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  test('returns undefined when run is not found', () => {
    const deps = makeDeps(undefined)
    const result = getRunFinalAssistantText(deps, 'nonexistent')
    expect(result).toBeUndefined()
  })

  test('returns undefined when run has neither hrcRunId nor hostSessionId', () => {
    const run = makeRun() // no hrcRunId, no hostSessionId
    const deps = makeDeps(run)
    const result = getRunFinalAssistantText(deps, 'run-1', fakeReaders())
    expect(result).toBeUndefined()
  })

  test('headless path takes priority when both hrcRunId and hostSessionId present', () => {
    const run = makeRun({
      hrcRunId: 'hrc-run-priority',
      hostSessionId: 'hsid-also-present',
    })
    const deps = makeDeps(run, '/fake/hrc.db')

    let headlessCalled = false
    let interactiveCalled = false

    const readers = fakeReaders({
      readCompletedAssistantMessageFromHrcEvents: () => {
        headlessCalled = true
        return makeMessageEndEvent('from headless')
      },
      readLatestAssistantMessageSeq: () => {
        interactiveCalled = true
        return 10
      },
    })

    getRunFinalAssistantText(deps, 'run-1', readers)
    expect(headlessCalled).toBe(true)
    expect(interactiveCalled).toBe(false)
  })

  // -----------------------------------------------------------------------
  // readCompletedAssistantMessageFromHrcEvents: synthesized completion must
  // not shadow the real reply (headless Codex regression)
  // -----------------------------------------------------------------------

  test('reader: real turn.message wins over content-less synthesized turn.completed', () => {
    const path = makeStore()
    const db = new Database(path)
    const insert = db.prepare(
      `INSERT INTO hrc_events (hrc_seq, run_id, event_kind, payload_json) VALUES (?, ?, ?, ?)`
    )
    // Headless Codex delivers the real reply as a turn.message, then on exit
    // synthesizes a content-less turn.completed because the driver never saw a
    // turn-completed marker in the child's stdout.
    insert.run(
      1,
      'hrc-run-shadow',
      'turn.message',
      JSON.stringify({
        type: 'message_end',
        message: { role: 'assistant', content: 'Magni Thorsson.' },
      })
    )
    insert.run(
      2,
      'hrc-run-shadow',
      'turn.completed',
      JSON.stringify({ success: true, transport: 'headless', source: 'launch_exit_synthesized' })
    )
    db.close()

    const event = readCompletedAssistantMessageFromHrcEvents(path, 'hrc-run-shadow')
    expect(event?.type).toBe('message_end')
    if (event?.type === 'message_end') {
      expect(event.message?.content).toEqual([{ type: 'text', text: 'Magni Thorsson.' }])
    }
  })

  test('reader: synthesized turn.completed alone still surfaces the degraded outcome', () => {
    const path = makeStore()
    const db = new Database(path)
    db.prepare(
      `INSERT INTO hrc_events (hrc_seq, run_id, event_kind, payload_json) VALUES (?, ?, ?, ?)`
    ).run(
      1,
      'hrc-run-degraded',
      'turn.completed',
      JSON.stringify({ success: true, transport: 'headless', source: 'launch_exit_synthesized' })
    )
    db.close()

    const event = readCompletedAssistantMessageFromHrcEvents(path, 'hrc-run-degraded')
    expect(event?.type).toBe('turn_end')
  })

  test('message_end with empty text returns undefined', () => {
    const run = makeRun({ hrcRunId: 'hrc-run-empty-text' })
    const deps = makeDeps(run)

    // visible-assistant-messages.ts returns undefined for empty text
    const emptyEvent: UnifiedSessionEvent = {
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: '   ' }] },
    }

    const readers = fakeReaders({
      readCompletedAssistantMessageFromHrcEvents: () => emptyEvent,
    })

    const result = getRunFinalAssistantText(deps, 'run-1', readers)
    // toCompletedVisibleAssistantMessage returns undefined for whitespace-only text
    expect(result).toBeUndefined()
  })
})
