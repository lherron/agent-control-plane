/**
 * T-13243: every decision read re-checks the T-13244 selector conditions on the
 * rows HRC returns. A daemon that ignores a selector (or a 503 from a
 * scope-keyed read) must push the decision to its safe branch: do not time out,
 * do not reap, never treat history as a reply.
 */
import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StoredRun } from '../src/domain/run-store.js'
import { protectWithTerminalCorrelationGrace } from '../src/integration/dispatch-timeout-terminal-grace.js'
import { lastObservedActivityMs } from '../src/integration/interface-run-dispatcher.js'
import {
  readAssistantMessageAfterSeq,
  readCompletedAssistantMessageAfterSeq,
  readLatestAssistantMessageSeq,
} from '../src/launcher-assistant-evidence.js'
import { findLiveTmuxRuntimeForSessionRef } from '../src/launcher-placement.js'
import {
  findLaunchIdForRun,
  hasInFlightHrcRunForSessionSince,
  hasInFlightHrcRunSince,
  hasRecentlyCompletedHrcRunSince,
  readRunStatus,
} from '../src/launcher-run-evidence.js'
import { createHrcRouteFake, sessionHomeUnreachable } from './fixtures/hrc-route-fake.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const SCOPE = 'agent:cody:project:agent-control-plane:task:T-13243'
const LANE = 'main'
const HOST = 'hsid-a'
const SESSION = { scopeRef: SCOPE, laneRef: LANE } as const
const SINCE = '2026-11-10T10:00:00.000Z'
const UNTIL = '2026-11-10T10:05:00.000Z'

function fixture(): { path: string; db: Database } {
  const dir = mkdtempSync(join(tmpdir(), 'hrc-route-selectors-'))
  dirs.push(dir)
  const path = join(dir, 'hrc-fixture.sqlite')
  const db = new Database(path)
  db.exec(`
    CREATE TABLE runs (run_id TEXT, host_session_id TEXT, runtime_id TEXT, scope_ref TEXT,
      lane_ref TEXT, status TEXT, accepted_at TEXT, completed_at TEXT, updated_at TEXT,
      error_code TEXT, error_message TEXT);
    CREATE TABLE hrc_events (hrc_seq INTEGER PRIMARY KEY, ts TEXT, host_session_id TEXT,
      scope_ref TEXT, lane_ref TEXT, generation INTEGER, run_id TEXT, launch_id TEXT,
      event_kind TEXT, evidence_origin TEXT, payload_json TEXT);
    CREATE TABLE runtimes (runtime_id TEXT, host_session_id TEXT, scope_ref TEXT, lane_ref TEXT,
      transport TEXT, status TEXT, tmux_json TEXT, updated_at TEXT);
    CREATE TABLE continuities (scope_ref TEXT, lane_ref TEXT, active_host_session_id TEXT);
  `)
  return { path, db }
}

function run(
  db: Database,
  r: {
    id: string
    host?: string
    scope?: string
    status: string
    accepted?: string | null
    completed?: string | null
    updated?: string
  }
): void {
  db.run(
    'INSERT INTO runs (run_id, host_session_id, scope_ref, lane_ref, status, accepted_at, completed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [
      r.id,
      r.host ?? HOST,
      r.scope ?? SCOPE,
      LANE,
      r.status,
      r.accepted ?? null,
      r.completed ?? null,
      r.updated ?? r.completed ?? r.accepted ?? SINCE,
    ]
  )
}

function message(text: string): string {
  return JSON.stringify({
    type: 'message_end',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  })
}

function event(
  db: Database,
  e: {
    seq: number
    ts?: string
    kind: string
    runId?: string | null
    host?: string
    generation?: number
    retained?: boolean
    payload?: string
    launchId?: string | null
  }
): void {
  db.run(
    'INSERT INTO hrc_events (hrc_seq, ts, host_session_id, scope_ref, lane_ref, generation, run_id, launch_id, event_kind, evidence_origin, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      e.seq,
      e.ts ?? SINCE,
      e.host ?? HOST,
      SCOPE,
      LANE,
      e.generation ?? 1,
      e.runId ?? null,
      e.launchId ?? null,
      e.kind,
      e.retained === true ? 'retained' : null,
      e.payload ?? '{}',
    ]
  )
}

function storedRun(overrides: Partial<StoredRun>): StoredRun {
  return {
    runId: 'acp-run',
    scopeRef: SCOPE,
    laneRef: LANE,
    status: 'running',
    createdAt: SINCE,
    updatedAt: '2026-11-10T09:00:00.000Z',
    ...overrides,
  } as StoredRun
}

describe('row 2: in-flight launch evidence', () => {
  test('selectors honoured: only an open run accepted inside the window counts', async () => {
    const { path, db } = fixture()
    run(db, { id: 'old', status: 'running', accepted: '2026-11-10T09:59:59.999Z' })
    run(db, { id: 'late', status: 'running', accepted: UNTIL })
    run(db, {
      id: 'done',
      status: 'completed',
      accepted: SINCE,
      completed: '2026-11-10T10:01:00.000Z',
    })
    const hrc = createHrcRouteFake(path)
    expect(await hasInFlightHrcRunSince(hrc, HOST, SINCE, UNTIL)).toBe(false)
    expect(await hasInFlightHrcRunForSessionSince(hrc, SESSION, SINCE, UNTIL)).toBe(false)
    run(db, { id: 'live', status: 'running', accepted: SINCE })
    expect(await hasInFlightHrcRunSince(hrc, HOST, SINCE, UNTIL)).toBe(true)
    expect(await hasInFlightHrcRunForSessionSince(hrc, SESSION, SINCE, UNTIL)).toBe(true)
    expect(await hasInFlightHrcRunSince(hrc, 'hsid-other', SINCE, UNTIL)).toBe(false)
    expect(hrc.calls.find((c) => c.route === 'runs')?.query).toMatchObject({
      hostSessionId: HOST,
      acceptedSince: SINCE,
      acceptedBefore: UNTIL,
      open: true,
    })
  })

  test('a daemon ignoring the selectors returns a stray row: spare the run (safe branch)', async () => {
    const { path, db } = fixture()
    run(db, {
      id: 'done',
      status: 'completed',
      accepted: SINCE,
      completed: '2026-11-10T10:01:00.000Z',
    })
    const hrc = createHrcRouteFake(path, { ignoreNewSelectors: true })
    expect(await hasInFlightHrcRunSince(hrc, HOST, SINCE, UNTIL)).toBe(true)
    expect(await hasInFlightHrcRunForSessionSince(hrc, SESSION, SINCE, UNTIL)).toBe(true)
  })

  test('a 503 from the scope-keyed read is "do not know": spare the run', async () => {
    const { path } = fixture()
    const hrc = createHrcRouteFake(path, {
      fail: (c) => (c.query['scopeRef'] !== undefined ? sessionHomeUnreachable() : undefined),
    })
    expect(await hasInFlightHrcRunForSessionSince(hrc, SESSION, SINCE, UNTIL)).toBe(true)
  })
})

describe('row 3: terminal correlation grace', () => {
  const pending = storedRun({ status: 'pending', hostSessionId: HOST })

  test('selectors honoured: the newest completed run inside the window is evidence', async () => {
    const { path, db } = fixture()
    const completed = new Date(Date.now() - 1_000).toISOString()
    run(db, { id: 'a', status: 'completed', accepted: SINCE, completed })
    run(db, {
      id: 'outside',
      status: 'completed',
      accepted: UNTIL,
      completed: new Date().toISOString(),
    })
    const hrc = createHrcRouteFake(path)
    expect(await hasRecentlyCompletedHrcRunSince(hrc, HOST, SINCE, UNTIL)).toEqual({
      runId: 'a',
      acceptedAt: SINCE,
      completedAt: completed,
    })
    expect(
      await protectWithTerminalCorrelationGrace({
        run: { ...pending, createdAt: SINCE },
        hrc,
        config: { intervalMs: 5_000, terminalCorrelationGraceMs: 60_000 },
      })
    ).toBe(true)
  })

  test('no run in the window: no evidence, no protection', async () => {
    const { path } = fixture()
    const hrc = createHrcRouteFake(path)
    expect(await hasRecentlyCompletedHrcRunSince(hrc, HOST, SINCE, UNTIL)).toBeUndefined()
    expect(
      await protectWithTerminalCorrelationGrace({
        run: pending,
        hrc,
        config: { intervalMs: 5_000 },
      })
    ).toBe(false)
  })

  test('a stray row from a daemon ignoring the selectors protects without minting a marker', async () => {
    const { path, db } = fixture()
    run(db, { id: 'open', status: 'running', accepted: '2026-11-10T08:00:00.000Z' })
    const hrc = createHrcRouteFake(path, { ignoreNewSelectors: true })
    expect(await hasRecentlyCompletedHrcRunSince(hrc, HOST, SINCE, UNTIL)).toBe('unknown')
    const updates: unknown[] = []
    expect(
      await protectWithTerminalCorrelationGrace({
        run: pending,
        hrc,
        runStore: { updateRun: (...args: unknown[]) => updates.push(args) } as never,
        config: { intervalMs: 5_000 },
      })
    ).toBe(true)
    expect(updates).toEqual([])
  })
})

describe('row 9: last live activity for the stale decision', () => {
  test('a retained newest row from a daemon ignoring liveOnly does not let the run time out', async () => {
    const { path, db } = fixture()
    event(db, { seq: 1, ts: '2026-11-10T09:00:00.000Z', kind: 'turn.started', runId: 'hrc-1' })
    event(db, {
      seq: 2,
      ts: '2026-11-10T09:00:00.000Z',
      kind: 'turn.message',
      runId: 'hrc-1',
      retained: true,
    })
    const run = storedRun({ hrcRunId: 'hrc-1', hostSessionId: HOST, generation: 1 })
    const before = Date.now()
    const ignoring = await lastObservedActivityMs(
      run,
      createHrcRouteFake(path, { ignoreNewSelectors: true })
    )
    expect(ignoring).toBeGreaterThanOrEqual(before)
    const honoured = await lastObservedActivityMs(run, createHrcRouteFake(path))
    expect(honoured).toBe(Date.parse('2026-11-10T09:00:00.000Z'))
  })

  test('by session: rows at or below afterHrcSeq are not activity; above it they are', async () => {
    const { path, db } = fixture()
    event(db, { seq: 5, ts: '2026-11-10T09:30:00.000Z', kind: 'turn.message' })
    const run = storedRun({ hostSessionId: HOST, generation: 1, afterHrcSeq: 5 })
    const hrc = createHrcRouteFake(path)
    expect(await lastObservedActivityMs(run, hrc)).toBe(Date.parse(run.updatedAt))
    event(db, { seq: 6, ts: '2026-11-10T09:40:00.000Z', kind: 'turn.message' })
    expect(await lastObservedActivityMs(run, hrc)).toBe(Date.parse('2026-11-10T09:40:00.000Z'))
    const tail = hrc.calls.filter((c) => c.route === 'events.tail').at(-1)?.query
    expect(tail).toMatchObject({ hostSessionId: HOST, afterSeq: 5, liveOnly: true, limit: 1 })
    expect(tail?.['scopeRef']).toBeUndefined()
  })

  test('an HRC read failure is "do not know": the run is treated as active now', async () => {
    const { path } = fixture()
    const run = storedRun({ hrcRunId: 'hrc-1', hostSessionId: HOST })
    const before = Date.now()
    const hrc = createHrcRouteFake(path, { fail: () => sessionHomeUnreachable() })
    expect(await lastObservedActivityMs(run, hrc)).toBeGreaterThanOrEqual(before)
  })
})

describe('row 5: reply text and completion by session', () => {
  test('retained rows are never a reply or a baseline, even when liveOnly is ignored', async () => {
    const { path, db } = fixture()
    event(db, { seq: 1, kind: 'turn.message', runId: 'hrc-1', payload: message('live one') })
    event(db, { seq: 2, kind: 'turn.completed', runId: 'hrc-1', payload: '{}' })
    event(db, {
      seq: 3,
      kind: 'turn.message',
      runId: 'hrc-1',
      retained: true,
      payload: message('history'),
    })
    event(db, { seq: 4, kind: 'turn.completed', runId: 'hrc-1', retained: true, payload: '{}' })
    for (const ignoreNewSelectors of [false, true]) {
      const hrc = createHrcRouteFake(path, { ignoreNewSelectors })
      expect(
        await readLatestAssistantMessageSeq(hrc, { hostSessionId: HOST, sessionRef: SESSION })
      ).toBe(1)
      expect(
        await readAssistantMessageAfterSeq({
          hrc,
          hostSessionId: HOST,
          sessionRef: SESSION,
          afterHrcSeq: 1,
        })
      ).toBeUndefined()
      expect(
        await readCompletedAssistantMessageAfterSeq({
          hrc,
          hostSessionId: HOST,
          sessionRef: SESSION,
          afterHrcSeq: 2,
        })
      ).toBeUndefined()
      const reply = await readCompletedAssistantMessageAfterSeq({
        hrc,
        hostSessionId: HOST,
        sessionRef: SESSION,
        afterHrcSeq: 0,
      })
      expect(JSON.stringify(reply)).toContain('live one')
    }
  })

  test('the latest-seq baseline pages past more retained rows than one tail page', async () => {
    const { path, db } = fixture()
    event(db, { seq: 1, kind: 'turn.message', payload: message('live') })
    for (let seq = 2; seq <= 140; seq += 1)
      event(db, { seq, kind: 'turn.message', retained: true, payload: message('old') })
    const hrc = createHrcRouteFake(path, { ignoreNewSelectors: true })
    expect(
      await readLatestAssistantMessageSeq(hrc, { hostSessionId: HOST, sessionRef: SESSION })
    ).toBe(1)
  })
})

describe('rows 1, 4 and 7: run facts and placement', () => {
  test('launch id is the first non-null launchId on the run; status is the exact run row', async () => {
    const { path, db } = fixture()
    event(db, { seq: 1, kind: 'turn.accepted', runId: 'hrc-1' })
    event(db, { seq: 2, kind: 'turn.started', runId: 'hrc-1', launchId: 'launch-a' })
    event(db, { seq: 3, kind: 'turn.started', runId: 'hrc-1', launchId: 'launch-b' })
    db.run(
      "INSERT INTO runs (run_id, status, error_code, error_message) VALUES ('hrc-1', 'failed', 'runtime_unavailable', 'gone')"
    )
    const hrc = createHrcRouteFake(path)
    expect(await findLaunchIdForRun(hrc, 'hrc-1')).toBe('launch-a')
    expect(await findLaunchIdForRun(hrc, 'missing')).toBeUndefined()
    expect(await readRunStatus(hrc, 'hrc-1')).toEqual({
      status: 'failed',
      errorCode: 'runtime_unavailable',
      errorMessage: 'gone',
    })
    expect(await readRunStatus(hrc, 'missing')).toBeUndefined()
  })

  test('placement takes the newest live tmux runtime with tmux facts on the active host session', async () => {
    const { path, db } = fixture()
    db.run('INSERT INTO continuities VALUES (?, ?, ?)', [SCOPE, LANE, HOST])
    const rt = (
      id: string,
      transport: string,
      status: string,
      tmux: string | null,
      updated: string
    ) =>
      db.run(
        'INSERT INTO runtimes (runtime_id, host_session_id, transport, status, tmux_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        [id, HOST, transport, status, tmux, updated]
      )
    rt('rt-dead', 'tmux', 'exited', '{}', '2026-11-10T10:09:00.000Z')
    rt('rt-headless', 'headless', 'ready', null, '2026-11-10T10:08:00.000Z')
    rt('rt-notmux', 'tmux', 'ready', null, '2026-11-10T10:07:00.000Z')
    rt('rt-old', 'tmux', 'ready', '{}', '2026-11-10T10:01:00.000Z')
    rt('rt-live', 'tmux', 'busy', '{}', '2026-11-10T10:05:00.000Z')
    const hrc = createHrcRouteFake(path)
    expect(await findLiveTmuxRuntimeForSessionRef(hrc, SESSION)).toEqual({
      hostSessionId: HOST,
      runtimeId: 'rt-live',
    })
    expect(
      await findLiveTmuxRuntimeForSessionRef(hrc, { ...SESSION, laneRef: 'other' })
    ).toBeUndefined()
  })
})
