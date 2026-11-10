import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hasHrcEvidenceOrigin } from '../src/hrc-evidence-origin.js'
import {
  readAssistantMessageAfterSeq,
  readLatestAssistantMessageSeq,
} from '../src/launcher-assistant-evidence.js'
import { createHrcRouteFake } from './fixtures/hrc-route-fake.js'

const fixtureDirs: string[] = []

afterEach(() => {
  for (const dir of fixtureDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const SCOPE = 'agent:smokey:project:agent-control-plane:task:T-08575'
const SESSION = { scopeRef: SCOPE, laneRef: 'main' } as const

function message(text: string): string {
  return JSON.stringify({
    type: 'message_end',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  })
}

/** An HRC event fixture: live seq 1, then a retained copy of history at seq 2. */
function createFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'acp-hrc-evidence-'))
  fixtureDirs.push(dir)
  const hrcFixture = join(dir, 'hrc-fixture.sqlite')
  const db = new Database(hrcFixture)
  db.exec(`
    CREATE TABLE hrc_events (
      hrc_seq INTEGER PRIMARY KEY,
      ts TEXT NOT NULL,
      host_session_id TEXT NOT NULL,
      scope_ref TEXT NOT NULL,
      lane_ref TEXT NOT NULL,
      generation INTEGER NOT NULL,
      run_id TEXT,
      event_kind TEXT NOT NULL,
      evidence_origin TEXT,
      payload_json TEXT NOT NULL
    );
  `)
  const insert = db.prepare('INSERT INTO hrc_events VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)')
  insert.run(
    1,
    '2026-09-16T00:00:00.000Z',
    'hsid-t0',
    SCOPE,
    'main',
    'run-1',
    'turn.message',
    null,
    message('live')
  )
  insert.run(
    2,
    '2026-09-15T00:00:00.000Z',
    'hsid-t0',
    SCOPE,
    'main',
    'run-0',
    'turn.message',
    'retained',
    message('history')
  )
  db.close()
  return hrcFixture
}

describe('hasHrcEvidenceOrigin', () => {
  test('any present origin marks history; absent or null is live', () => {
    expect(hasHrcEvidenceOrigin({ evidenceOrigin: 'retained' })).toBe(true)
    expect(hasHrcEvidenceOrigin({ evidenceOrigin: 'imported' })).toBe(true)
    expect(hasHrcEvidenceOrigin({ evidenceOrigin: null })).toBe(false)
    expect(hasHrcEvidenceOrigin({})).toBe(false)
  })
})

describe('retained rows over HRC routes', () => {
  for (const ignoreNewSelectors of [false, true]) {
    test(`a retained row is never a baseline or a reply (ignoreNewSelectors=${ignoreNewSelectors})`, async () => {
      const hrc = createHrcRouteFake(createFixture(), { ignoreNewSelectors })
      const input = { hostSessionId: 'hsid-t0', sessionRef: SESSION }
      expect(await readLatestAssistantMessageSeq(hrc, input)).toBe(1)
      expect(await readAssistantMessageAfterSeq({ hrc, ...input, afterHrcSeq: 1 })).toBeUndefined()
      expect(
        JSON.stringify(await readAssistantMessageAfterSeq({ hrc, ...input, afterHrcSeq: 0 }))
      ).toContain('live')
    })
  }
})
