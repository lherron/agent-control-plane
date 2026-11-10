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
import { createHrcRouteFake, sessionHomeUnreachable } from './fixtures/hrc-route-fake.js'

const since = '2026-11-09T00:00:00.000Z'
const until = '2026-11-09T00:05:00.000Z'

test('correlation preserves inclusive lower/exclusive upper edges, lineage and terminal filtering', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'launcher-bounds-'))
  const hrcFixture = join(dir, 'hrc-fixture.sqlite')
  const db = new Database(hrcFixture)
  const hrc = createHrcRouteFake(hrcFixture)
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
      expect(await hasInFlightHrcRunSince(hrc, 'successor', since, until)).toBe(row.expected)
      expect(await hasInFlightHrcRunForSessionSince(hrc, session, since, until)).toBe(row.expected)
      expect(await hasInFlightHrcRunSince(hrc, 'predecessor', since, until)).toBe(false)
      expect(
        await hasInFlightHrcRunForSessionSince(hrc, { ...session, laneRef: 'other' }, since, until)
      ).toBe(false)
      expect(await hasInFlightHrcRunSince(hrc, 'successor', since)).toBe(
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
    expect(await hasRecentlyCompletedHrcRunSince(hrc, 'host', since, until)).toEqual({
      runId: 'z',
      acceptedAt: since,
      completedAt: until,
    })
    expect(launchCorrelationUntilIso(since)).toBe(until)
    expect(launchCorrelationUntilIso('invalid')).toBeUndefined()
    // A failed HRC read is "do not know": spare the run, and grant no marker.
    const failing = createHrcRouteFake(hrcFixture, { fail: () => sessionHomeUnreachable() })
    expect(await hasInFlightHrcRunSince(failing, 'host', since)).toBe(true)
    expect(await hasInFlightHrcRunForSessionSince(failing, session, since)).toBe(true)
    expect(await hasRecentlyCompletedHrcRunSince(failing, 'host', since)).toBe('unknown')
    db.exec('DROP TABLE runs')
    expect(await hasInFlightHrcRunSince(hrc, 'host', since)).toBe(false)
    expect(await hasInFlightHrcRunForSessionSince(hrc, session, since)).toBe(false)
    expect(await hasRecentlyCompletedHrcRunSince(hrc, 'host', since)).toBeUndefined()
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
