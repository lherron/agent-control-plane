import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { StoredRun } from '../domain/run-store.js'
import * as dispatcherModule from './interface-run-dispatcher.js'

type ActivityModule = typeof dispatcherModule & {
  lastObservedActivityMs?: (run: StoredRun, hrcDbPath: string) => number
}

const fixtureDirs: string[] = []

afterEach(() => {
  while (fixtureDirs.length > 0) {
    const dir = fixtureDirs.pop()
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

describe('interface run dispatcher stale activity window', () => {
  test('uses recent hrc_events activity to keep an old running run from going stale', () => {
    const now = Date.now()
    const hrc = createHrcDb()
    const run = makeRun({
      status: 'running',
      updatedAt: isoAgo(now, 12 * 60_000),
      hrcRunId: 'hrc-run-active',
      hostSessionId: 'hsid-active',
      generation: 4,
    })

    insertHrcEvent(hrc.db, {
      ts: isoAgo(now, 9 * 60_000),
      runId: run.hrcRunId,
      hostSessionId: run.hostSessionId,
      scopeRef: run.scopeRef,
      laneRef: run.laneRef,
      generation: run.generation,
    })
    insertHrcEvent(hrc.db, {
      ts: isoAgo(now, 10_000),
      runId: run.hrcRunId,
      hostSessionId: run.hostSessionId,
      scopeRef: run.scopeRef,
      laneRef: run.laneRef,
      generation: run.generation,
    })

    expect(isStaleFromLastObservedActivity(run, hrc.hrcDbPath, 600_000)).toBe(false)
  })

  test('treats an old running run with no correlated hrc_events activity as stale', () => {
    const now = Date.now()
    const hrc = createHrcDb()
    const run = makeRun({
      status: 'running',
      updatedAt: isoAgo(now, 12 * 60_000),
      hrcRunId: 'hrc-run-missing',
      hostSessionId: 'hsid-missing',
      generation: 7,
    })

    insertHrcEvent(hrc.db, {
      ts: isoAgo(now, 10_000),
      runId: 'other-hrc-run',
      hostSessionId: run.hostSessionId,
      scopeRef: run.scopeRef,
      laneRef: run.laneRef,
      generation: run.generation,
    })

    expect(isStaleFromLastObservedActivity(run, hrc.hrcDbPath, 600_000)).toBe(true)
  })

  test('treats an old running run with only old hrc_events activity as stale', () => {
    const now = Date.now()
    const hrc = createHrcDb()
    const run = makeRun({
      status: 'running',
      updatedAt: isoAgo(now, 12 * 60_000),
      hrcRunId: 'hrc-run-idle',
      hostSessionId: 'hsid-idle',
      generation: 2,
    })

    insertHrcEvent(hrc.db, {
      ts: isoAgo(now, 15 * 60_000),
      runId: run.hrcRunId,
      hostSessionId: run.hostSessionId,
      scopeRef: run.scopeRef,
      laneRef: run.laneRef,
      generation: run.generation,
    })

    expect(isStaleFromLastObservedActivity(run, hrc.hrcDbPath, 600_000)).toBe(true)
  })

  test('does not slide pending dispatch timeout for runs without hrcRunId', () => {
    const now = Date.now()
    const hrc = createHrcDb()
    const run = makeRun({
      status: 'pending',
      updatedAt: isoAgo(now, 12 * 60_000),
      hostSessionId: 'hsid-pending',
      generation: 5,
    })

    insertHrcEvent(hrc.db, {
      ts: isoAgo(now, 10_000),
      runId: 'hrc-run-not-yet-correlated',
      hostSessionId: run.hostSessionId,
      scopeRef: run.scopeRef,
      laneRef: run.laneRef,
      generation: run.generation,
    })

    expect(isStaleFromLastObservedActivity(run, hrc.hrcDbPath, 45_000)).toBe(true)
  })

  test('clamps future hrc_events timestamps to now before stale math', () => {
    const now = Date.now()
    const hrc = createHrcDb()
    const run = makeRun({
      status: 'running',
      updatedAt: isoAgo(now, 12 * 60_000),
      hrcRunId: 'hrc-run-future',
      hostSessionId: 'hsid-future',
      generation: 9,
    })

    insertHrcEvent(hrc.db, {
      ts: new Date(now + 5 * 60_000).toISOString(),
      runId: run.hrcRunId,
      hostSessionId: run.hostSessionId,
      scopeRef: run.scopeRef,
      laneRef: run.laneRef,
      generation: run.generation,
    })

    const before = Date.now()
    const observed = lastObservedActivityMs(run, hrc.hrcDbPath)
    const after = Date.now()

    expect(observed).toBeGreaterThanOrEqual(before)
    expect(observed).toBeLessThanOrEqual(after)
    expect(after - observed > 600_000).toBe(false)
  })
})

function isStaleFromLastObservedActivity(
  run: StoredRun,
  hrcDbPath: string,
  staleTimeoutMs: number
): boolean {
  return Date.now() - lastObservedActivityMs(run, hrcDbPath) > staleTimeoutMs
}

function lastObservedActivityMs(run: StoredRun, hrcDbPath: string): number {
  const helper = (dispatcherModule as ActivityModule).lastObservedActivityMs
  if (typeof helper !== 'function') {
    throw new Error(
      'Expected interface-run-dispatcher to export lastObservedActivityMs(run, hrcDbPath)'
    )
  }
  return helper(run, hrcDbPath)
}

function createHrcDb(): { db: Database; hrcDbPath: string } {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'acp-interface-stale-'))
  fixtureDirs.push(fixtureDir)
  const hrcDbPath = join(fixtureDir, 'hrc.sqlite')
  const db = new Database(hrcDbPath)
  db.exec(`
    CREATE TABLE hrc_events (
      hrc_seq INTEGER PRIMARY KEY AUTOINCREMENT,
      stream_seq INTEGER NOT NULL UNIQUE,
      ts TEXT NOT NULL,
      host_session_id TEXT NOT NULL,
      scope_ref TEXT NOT NULL,
      lane_ref TEXT NOT NULL,
      generation INTEGER NOT NULL,
      runtime_id TEXT,
      run_id TEXT,
      launch_id TEXT,
      app_id TEXT,
      app_session_key TEXT,
      category TEXT NOT NULL,
      event_kind TEXT NOT NULL,
      transport TEXT,
      error_code TEXT,
      replayed INTEGER NOT NULL DEFAULT 0,
      payload_json TEXT NOT NULL
    );
  `)
  return { db, hrcDbPath }
}

function insertHrcEvent(
  db: Database,
  input: {
    ts: string
    runId: string | undefined
    hostSessionId: string | undefined
    scopeRef: string
    laneRef: string
    generation: number | undefined
  }
): void {
  db.run(
    `INSERT INTO hrc_events (
      stream_seq,
      ts,
      host_session_id,
      scope_ref,
      lane_ref,
      generation,
      run_id,
      category,
      event_kind,
      payload_json
    ) VALUES (
      (SELECT COALESCE(MAX(stream_seq), 0) + 1 FROM hrc_events),
      ?, ?, ?, ?, ?, ?, 'turn', 'turn.message', ?
    )`,
    input.ts,
    input.hostSessionId ?? 'hsid-default',
    input.scopeRef,
    input.laneRef,
    input.generation ?? 0,
    input.runId ?? null,
    JSON.stringify({ type: 'turn_delta', text: 'progress' })
  )
}

function makeRun(overrides: Partial<StoredRun> = {}): StoredRun {
  const now = new Date().toISOString()
  return {
    runId: 'acp-run-1',
    scopeRef: 'agent:smokey:project:agent-spaces',
    laneRef: 'main',
    actor: { kind: 'user', id: 'discord:user:1' },
    status: 'running',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

function isoAgo(now: number, ageMs: number): string {
  return new Date(now - ageMs).toISOString()
}
