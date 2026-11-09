import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  hasInFlightHrcRunForSessionSince,
  hasInFlightHrcRunSince,
  hasRecentlyCompletedHrcRunSince,
  launchCorrelationUntilIso,
} from '../src/launcher-run-evidence.js'

const since = '2026-11-09T00:00:00.000Z'
const until = '2026-11-09T00:05:00.000Z'

test('correlation preserves inclusive lower/exclusive upper edges, lineage and terminal filtering', () => {
  const dir = mkdtempSync(join(tmpdir(), 'launcher-bounds-'))
  const path = join(dir, 'hrc.sqlite')
  const db = new Database(path)
  db.exec(`CREATE TABLE runs (
    run_id TEXT, host_session_id TEXT, scope_ref TEXT, lane_ref TEXT,
    accepted_at TEXT, completed_at TEXT
  )`)
  const session = { scopeRef: 'agent:cody:project:agent-control-plane', laneRef: 'main' }
  try {
    for (const row of [
      { accepted: '2026-11-08T23:59:59.999Z', completed: null, expected: false },
      { accepted: since, completed: null, expected: true },
      { accepted: until, completed: null, expected: false },
      { accepted: since, completed: until, expected: false },
    ]) {
      db.run('DELETE FROM runs')
      db.run(
        'INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?)',
        'run',
        'successor',
        session.scopeRef,
        session.laneRef,
        row.accepted,
        row.completed
      )
      expect(hasInFlightHrcRunSince(path, 'successor', since, until)).toBe(row.expected)
      expect(hasInFlightHrcRunForSessionSince(path, session, since, until)).toBe(row.expected)
      expect(hasInFlightHrcRunSince(path, 'predecessor', since, until)).toBe(false)
      expect(
        hasInFlightHrcRunForSessionSince(path, { ...session, laneRef: 'other' }, since, until)
      ).toBe(false)
      expect(hasInFlightHrcRunSince(path, 'successor', since)).toBe(
        row.completed === null && row.accepted >= since
      )
    }
    db.run('DELETE FROM runs')
    for (const id of ['a', 'z']) {
      db.run(
        'INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?)',
        id,
        'host',
        session.scopeRef,
        session.laneRef,
        since,
        until
      )
    }
    expect(hasRecentlyCompletedHrcRunSince(path, 'host', since, until)).toEqual({
      runId: 'z',
      acceptedAt: since,
      completedAt: until,
    })
    expect(launchCorrelationUntilIso(since)).toBe(until)
    expect(launchCorrelationUntilIso('invalid')).toBeUndefined()
    db.exec('DROP TABLE runs')
    expect(hasInFlightHrcRunSince(path, 'host', since)).toBe(false)
    expect(hasInFlightHrcRunForSessionSince(path, session, since)).toBe(false)
    expect(hasRecentlyCompletedHrcRunSince(path, 'host', since)).toBeUndefined()
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
