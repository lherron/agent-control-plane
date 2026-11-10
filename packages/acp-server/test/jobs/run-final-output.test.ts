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
import { readCompletedAssistantMessageFromHrcEvents } from '../../src/launcher-assistant-evidence.js'
import { type HrcRouteFakeOptions, createHrcRouteFake } from '../fixtures/hrc-route-fake.js'

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

function makeDeps(
  run: StoredRun | undefined,
  hrcFixture?: string,
  routes: HrcRouteFakeOptions = {}
): RunFinalOutputDeps {
  return {
    getRun: () => run,
    hrc: createHrcRouteFake(hrcFixture ?? new Database(':memory:'), routes),
  }
}

function makeStore(): string {
  const dir = mkdtempSync(join(tmpdir(), 'acp-run-final-output-'))
  tempDirs.push(dir)
  const path = join(dir, 'hrc-fixture.sqlite')
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
    readCompletedAssistantMessageFromHrcEvents: async () => undefined,
    readLatestAssistantMessageSeq: async () => 0,
    readAssistantMessageAfterSeq: async () => undefined,
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

  test('headless: reads final output from canonical hrc_events', async () => {
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
    const result = await getRunFinalAssistantText(makeDeps(run, path), 'run-1')
    expect(result).toBe('canonical reply')
  })

  test('headless: ignores raw events when hrc_events has no final output', async () => {
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
    const result = await getRunFinalAssistantText(makeDeps(run, path), 'run-1')
    expect(result).toBeUndefined()
  })

  // -----------------------------------------------------------------------
  // Interactive/tmux path (hostSessionId)
  // -----------------------------------------------------------------------

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  test('returns undefined when run is not found', async () => {
    const deps = makeDeps(undefined)
    const result = await getRunFinalAssistantText(deps, 'nonexistent')
    expect(result).toBeUndefined()
  })

  test('returns undefined when run has neither hrcRunId nor hostSessionId, even when HRC readers have text', async () => {
    const run = makeRun() // no hrcRunId, no hostSessionId
    const deps = makeDeps(run)
    const result = await getRunFinalAssistantText(
      deps,
      'run-1',
      fakeReaders({
        readCompletedAssistantMessageFromHrcEvents: async () =>
          makeMessageEndEvent('headless leak'),
        readLatestAssistantMessageSeq: async () => 10,
        readAssistantMessageAfterSeq: async () => makeMessageEndEvent('interactive leak'),
      })
    )
    expect(result).toBeUndefined()
  })

  test('headless text wins when a run carries both hrcRunId and hostSessionId', async () => {
    const run = makeRun({
      hrcRunId: 'hrc-run-priority',
      hostSessionId: 'hsid-also-present',
    })
    const deps = makeDeps(run)

    const readers = fakeReaders({
      readCompletedAssistantMessageFromHrcEvents: async () => makeMessageEndEvent('from headless'),
      readLatestAssistantMessageSeq: async () => 10,
      readAssistantMessageAfterSeq: async () => makeMessageEndEvent('from interactive'),
    })

    expect(await getRunFinalAssistantText(deps, 'run-1', readers)).toBe('from headless')
  })

  // -----------------------------------------------------------------------
  // readCompletedAssistantMessageFromHrcEvents: synthesized completion must
  // not shadow the real reply (headless Codex regression)
  // -----------------------------------------------------------------------

  test('reader: real turn.message wins over content-less synthesized turn.completed', async () => {
    const path = makeStore()
    const db = new Database(path)
    const insert = db.prepare(
      'INSERT INTO hrc_events (hrc_seq, run_id, event_kind, payload_json) VALUES (?, ?, ?, ?)'
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

    const event = await readCompletedAssistantMessageFromHrcEvents(
      createHrcRouteFake(path),
      'hrc-run-shadow'
    )
    expect(event?.type).toBe('message_end')
    if (event?.type === 'message_end') {
      expect(event.message?.content).toEqual([{ type: 'text', text: 'Magni Thorsson.' }])
    }
  })

  test('reader: synthesized turn.completed alone still surfaces the degraded outcome', async () => {
    const path = makeStore()
    const db = new Database(path)
    db.prepare(
      'INSERT INTO hrc_events (hrc_seq, run_id, event_kind, payload_json) VALUES (?, ?, ?, ?)'
    ).run(
      1,
      'hrc-run-degraded',
      'turn.completed',
      JSON.stringify({ success: true, transport: 'headless', source: 'launch_exit_synthesized' })
    )
    db.close()

    const event = await readCompletedAssistantMessageFromHrcEvents(
      createHrcRouteFake(path),
      'hrc-run-degraded'
    )
    expect(event?.type).toBe('turn_end')
  })

  test.each([{ text: '' }, { text: '   ' }])(
    'a blank final assistant message in hrc_events yields no final text: $text',
    async ({ text }) => {
      const path = makeStore()
      const db = new Database(path)
      db.prepare(
        'INSERT INTO hrc_events (hrc_seq, run_id, event_kind, payload_json) VALUES (?, ?, ?, ?)'
      ).run(
        1,
        'hrc-run-empty-text',
        'turn.message',
        JSON.stringify({
          type: 'message_end',
          message: { role: 'assistant', content: [{ type: 'text', text }] },
        })
      )
      db.close()

      const run = makeRun({ hrcRunId: 'hrc-run-empty-text' })
      expect(await getRunFinalAssistantText(makeDeps(run, path), 'run-1')).toBeUndefined()
    }
  )
})

function makeRetainedOutputStore(): string {
  const dir = mkdtempSync(join(tmpdir(), 'acp-run-final-output-retained-'))
  tempDirs.push(dir)
  const path = join(dir, 'hrc-fixture.sqlite')
  const db = new Database(path)
  db.exec(`
    CREATE TABLE hrc_events (
      hrc_seq INTEGER PRIMARY KEY,
      host_session_id TEXT NOT NULL,
      scope_ref TEXT NOT NULL,
      lane_ref TEXT NOT NULL,
      run_id TEXT,
      event_kind TEXT NOT NULL,
      replayed INTEGER NOT NULL DEFAULT 0,
      payload_json TEXT NOT NULL,
      evidence_origin TEXT CHECK (evidence_origin IS NULL OR evidence_origin = 'retained')
    );
  `)
  db.close()
  return path
}

function insertOutputMessage(
  db: Database,
  input: { hrcSeq: number; text: string; evidenceOrigin: 'retained' | null }
): void {
  db.run(
    `INSERT INTO hrc_events (
      hrc_seq, host_session_id, scope_ref, lane_ref, run_id, event_kind,
      payload_json, evidence_origin
    ) VALUES (?, 'hsid-output', 'agent:larry@project:demo', 'main', ?, 'turn.message', ?, ?)`,
    input.hrcSeq,
    `run-${input.hrcSeq}`,
    JSON.stringify({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: input.text }] },
    }),
    input.evidenceOrigin
  )
}

// T-08575: S1 and S2 must stay coherent on ordinary-origin output, and S1
// HRC read failures must reach callers instead of becoming an empty result.
describe('T-08575 run final output retained-evidence fence', () => {
  test('T3c S1 and S2 select the same latest ordinary-origin assistant message', async () => {
    const path = makeRetainedOutputStore()
    const db = new Database(path)
    insertOutputMessage(db, { hrcSeq: 7, text: 'LIVE-EARLY', evidenceOrigin: null })
    insertOutputMessage(db, { hrcSeq: 8, text: 'OLD-EARLY', evidenceOrigin: 'retained' })
    insertOutputMessage(db, { hrcSeq: 9, text: 'X', evidenceOrigin: null })
    insertOutputMessage(db, { hrcSeq: 10, text: 'OLD-REPLY', evidenceOrigin: 'retained' })
    db.close()

    const run = makeRun({ hostSessionId: 'hsid-output', generation: 1 })
    expect(await getRunFinalAssistantText(makeDeps(run, path), run.runId)).toBe('X')
  })

  test('T-Q1b an HRC read failure on the session path propagates', async () => {
    const path = makeRetainedOutputStore()
    const run = makeRun({ hostSessionId: 'hsid-output', generation: 1 })
    await expect(
      getRunFinalAssistantText(
        makeDeps(run, path, { fail: () => new Error('HRC events route unavailable') }),
        run.runId
      )
    ).rejects.toThrow(/HRC events route unavailable/)
  })

  test('T3c retained rows stay out of the final text when HRC ignores liveOnly', async () => {
    const path = makeRetainedOutputStore()
    const db = new Database(path)
    insertOutputMessage(db, { hrcSeq: 9, text: 'X', evidenceOrigin: null })
    insertOutputMessage(db, { hrcSeq: 10, text: 'OLD-REPLY', evidenceOrigin: 'retained' })
    db.close()
    const run = makeRun({ hostSessionId: 'hsid-output', generation: 1 })
    expect(
      await getRunFinalAssistantText(makeDeps(run, path, { ignoreNewSelectors: true }), run.runId)
    ).toBe('X')
  })

  test('T-Q1b control returns undefined for an empty recognized hrc_events table', async () => {
    const path = makeRetainedOutputStore()
    const run = makeRun({ hostSessionId: 'hsid-output', generation: 1 })
    expect(await getRunFinalAssistantText(makeDeps(run, path), run.runId)).toBeUndefined()
  })
})
