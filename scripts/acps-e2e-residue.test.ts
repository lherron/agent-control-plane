import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'

import {
  collectAcpsE2eResidue,
  parseAcpsE2eResidueArgs,
  renderAcpsE2eResidue,
} from './acps-e2e-residue.js'

const temporaryRoots: string[] = []

function createFixtureDatabase(): string {
  const root = join(tmpdir(), `acps-e2e-residue-${crypto.randomUUID()}`)
  mkdirSync(root, { recursive: true })
  temporaryRoots.push(root)
  const databasePath = join(root, 'state.sqlite')
  const database = new Database(databasePath)
  try {
    database.exec(`
      CREATE TABLE sessions (
        host_session_id TEXT PRIMARY KEY,
        scope_ref TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `)
    const insert = database.query(
      'INSERT INTO sessions (host_session_id, scope_ref, created_at) VALUES (?, ?, ?)'
    )
    insert.run(
      'hsid-1',
      'agent:curly:project:acps-e2e-aaaaaaaa:task:T-00001',
      '2026-06-01T01:00:00.000Z'
    )
    insert.run(
      'hsid-2',
      'agent:curly:project:acps-e2e-bbbbbbbb:task:T-00002',
      '2026-06-30T23:00:00.000Z'
    )
    insert.run(
      'hsid-3',
      'agent:curly:project:acps-e2e-cccccccc:task:T-00003',
      '2026-07-02T10:00:00.000Z'
    )
    // A later generation of an already-counted scope does not inflate scope residue.
    insert.run(
      'hsid-4',
      'agent:curly:project:acps-e2e-aaaaaaaa:task:T-00001',
      '2026-08-01T01:00:00.000Z'
    )
    insert.run(
      'hsid-nonhex',
      'agent:curly:project:acps-e2e-nothexzz:task:T-00004',
      '2026-05-01T01:00:00.000Z'
    )
    insert.run(
      'hsid-other',
      'agent:curly:project:agent-control-plane:task:T-00005',
      '2026-04-01T01:00:00.000Z'
    )
  } finally {
    database.close()
  }
  return databasePath
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('ACPS E2E residue dry-run', () => {
  test('counts distinct exact nonce scopes and summarizes their creation month read-only', () => {
    const databasePath = createFixtureDatabase()

    const report = collectAcpsE2eResidue(databasePath)

    expect(report).toEqual({
      databasePath,
      count: 3,
      oldest: '2026-06-01T01:00:00.000Z',
      newest: '2026-07-02T10:00:00.000Z',
      byMonth: [
        { month: '2026-06', count: 2 },
        { month: '2026-07', count: 1 },
      ],
    })
    expect(renderAcpsE2eResidue(report)).toContain('No rows were changed.')

    const database = new Database(databasePath, { readonly: true })
    try {
      expect(
        database.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM sessions').get()
      ).toEqual({ count: 6 })
    } finally {
      database.close()
    }
  })

  test('requires the explicit dry-run guard and resolves an override database path', () => {
    expect(() => parseAcpsE2eResidueArgs([])).toThrow('explicit --dry-run flag')
    expect(parseAcpsE2eResidueArgs(['--dry-run', '--db', './fixture.sqlite', '--json'])).toEqual({
      dryRun: true,
      databasePath: join(process.cwd(), 'fixture.sqlite'),
      json: true,
    })
  })
})
