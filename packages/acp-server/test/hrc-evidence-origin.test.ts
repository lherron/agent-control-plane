import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { hrcActuatingEvidenceClause } from '../src/hrc-evidence-origin.js'

const fixtureDirs: string[] = []

afterEach(() => {
  for (const dir of fixtureDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixturePath(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `acp-hrc-evidence-${name}-`))
  fixtureDirs.push(dir)
  return join(dir, 'hrc.sqlite')
}

function createOldStore(path = fixturePath('old')): Database {
  const db = new Database(path)
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
  return db
}

function createNewStore(path = fixturePath('new')): Database {
  const db = createOldStore(path)
  db.exec(`
    ALTER TABLE hrc_events ADD COLUMN evidence_origin TEXT
      CHECK (evidence_origin IS NULL OR evidence_origin = 'retained');
  `)
  return db
}

function retainedEvidenceCountForRollback(db: Database): number {
  const columns = db
    .query<{ name: string }, []>("SELECT name FROM pragma_table_info('hrc_events')")
    .all()
  if (columns.length === 0 || !columns.some((column) => column.name === 'hrc_seq')) {
    throw new Error('hrc_events schema unrecognized for rollback readback')
  }
  if (!columns.some((column) => column.name === 'evidence_origin')) return 0
  return (
    db
      .query<{ count: number }, []>(
        'SELECT COUNT(*) AS count FROM hrc_events WHERE evidence_origin IS NOT NULL'
      )
      .get()?.count ?? 0
  )
}

describe('hrcActuatingEvidenceClause', () => {
  // T-08575 T0: detection is deliberately per connection/read. These tests
  // pin the old/new schema boundary so an upgrade cannot require an ACP restart.
  test('T0a returns the actuating clause for the migrated HRC store', () => {
    const db = createNewStore()
    expect(hrcActuatingEvidenceClause(db)).toBe('AND evidence_origin IS NULL')
    db.close()
  })

  test('T0b returns no clause only for the positively recognized old store', () => {
    const db = createOldStore()
    expect(hrcActuatingEvidenceClause(db)).toBe('')
    db.close()
  })

  test('T0c rejects a missing hrc_events table', () => {
    const db = new Database(fixturePath('missing'))
    expect(() => hrcActuatingEvidenceClause(db)).toThrow('hrc_events schema unrecognized')
    db.close()
  })

  test('T0d rejects an hrc_events table without hrc_seq', () => {
    const db = new Database(fixturePath('malformed'))
    db.exec('CREATE TABLE hrc_events (event_kind TEXT NOT NULL)')
    expect(() => hrcActuatingEvidenceClause(db)).toThrow('hrc_events schema unrecognized')
    db.close()
  })

  test('T0e propagates a closed-database error', () => {
    const db = createOldStore()
    db.close()
    expect(() => hrcActuatingEvidenceClause(db)).toThrow()
  })

  test('T0f observes an in-place schema upgrade on the next call', () => {
    const db = createOldStore()
    expect(hrcActuatingEvidenceClause(db)).toBe('')
    db.exec(
      "ALTER TABLE hrc_events ADD COLUMN evidence_origin TEXT CHECK (evidence_origin IS NULL OR evidence_origin = 'retained')"
    )
    expect(hrcActuatingEvidenceClause(db)).toBe('AND evidence_origin IS NULL')
    db.close()
  })

  test('T0g keeps schema detection and selection on one deferred-transaction snapshot', () => {
    const path = fixturePath('snapshot')
    const reader = createOldStore(path)
    reader.exec('PRAGMA journal_mode = WAL')
    reader.run(
      `INSERT INTO hrc_events (
        hrc_seq, stream_seq, ts, host_session_id, scope_ref, lane_ref,
        generation, category, event_kind, payload_json
      ) VALUES (1, 1, '2026-09-16T00:00:00.000Z', 'hsid-t0',
        'agent:smokey:project:agent-control-plane:task:T-08575', 'main',
        1, 'turn', 'turn.message', '{}')`
    )
    const writer = new Database(path)
    writer.exec('PRAGMA journal_mode = WAL')

    const seen = reader
      .transaction(() => {
        expect(hrcActuatingEvidenceClause(reader)).toBe('')
        writer.exec(
          "ALTER TABLE hrc_events ADD COLUMN evidence_origin TEXT CHECK (evidence_origin IS NULL OR evidence_origin = 'retained')"
        )
        writer.run(
          `INSERT INTO hrc_events (
          hrc_seq, stream_seq, ts, host_session_id, scope_ref, lane_ref,
          generation, category, event_kind, payload_json, evidence_origin
        ) VALUES (2, 2, '2026-09-16T00:00:01.000Z', 'hsid-t0',
          'agent:smokey:project:agent-control-plane:task:T-08575', 'main',
          1, 'turn', 'turn.message', '{}', 'retained')`
        )
        return reader
          .query<{ hrcSeq: number }, []>('SELECT hrc_seq AS hrcSeq FROM hrc_events')
          .all()
      })
      .deferred()

    expect(seen).toEqual([{ hrcSeq: 1 }])
    expect(hrcActuatingEvidenceClause(reader)).toBe('AND evidence_origin IS NULL')
    expect(
      reader.query<{ hrcSeq: number }, []>('SELECT hrc_seq AS hrcSeq FROM hrc_events').all()
    ).toEqual([{ hrcSeq: 1 }, { hrcSeq: 2 }])
    writer.close()
    reader.close()
  })
})

describe('T0h rollback readback', () => {
  test('returns zero for old, counts present-origin rows for new, and refuses missing shapes', () => {
    const oldDb = createOldStore()
    expect(retainedEvidenceCountForRollback(oldDb)).toBe(0)
    oldDb.close()

    const newDb = createNewStore()
    newDb.run(
      `INSERT INTO hrc_events (
        hrc_seq, stream_seq, ts, host_session_id, scope_ref, lane_ref,
        generation, category, event_kind, payload_json, evidence_origin
      ) VALUES
        (1, 1, '2026-09-16T00:00:00.000Z', 'hsid-t0',
          'agent:smokey:project:agent-control-plane:task:T-08575', 'main',
          1, 'turn', 'turn.message', '{}', NULL),
        (2, 2, '2026-09-16T00:00:01.000Z', 'hsid-t0',
          'agent:smokey:project:agent-control-plane:task:T-08575', 'main',
          1, 'turn', 'turn.message', '{}', 'retained')`
    )
    expect(retainedEvidenceCountForRollback(newDb)).toBe(1)
    newDb.close()

    const missingDb = new Database(fixturePath('rollback-missing'))
    expect(() => retainedEvidenceCountForRollback(missingDb)).toThrow(
      'hrc_events schema unrecognized for rollback readback'
    )
    missingDb.close()
  })
})
