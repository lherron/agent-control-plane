import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  assertInjectorAdmissible,
  importInjectorStateStore,
  injectorTableParity,
  openInjectorStateStore,
  readInjectorImportMarker,
} from '../src/index.js'

const roots: string[] = []

function freshPath(name: string): string {
  const root = mkdtempSync(join(tmpdir(), 'hrc-injector-core-'))
  roots.push(root)
  return join(root, name)
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('injector state import', () => {
  test('copies the Phase-3 private store with parity before atomically writing the marker', () => {
    const sourcePath = freshPath('phase3.sqlite')
    openInjectorStateStore(sourcePath).close()
    const source = new Database(sourcePath)
    source
      .query(
        `INSERT INTO hrcmail_delivery_intents (
        envelope_id, target_session_ref, door, form, presentation_id,
        submitted_hrc_seq, submitted_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        'EN-00001',
        'agent:test:project:acp/lane:main',
        'enqueue',
        'full',
        'p-1',
        1,
        'now',
        'now'
      )
    source
      .query('INSERT INTO wrkq_ledger_cursors (stream, high_water, updated_at) VALUES (?, ?, ?)')
      .run('envelope', 7, 'now')
    source.close()

    const destinationPath = freshPath('injector.sqlite')
    const destination = openInjectorStateStore(destinationPath)
    destination.close()
    const destinationDb = new Database(destinationPath)
    importInjectorStateStore(destinationDb, { sourcePath })
    destinationDb.close()

    expect(readInjectorImportMarker(destinationPath, sourcePath)).toEqual({
      sourcePath,
      importedAt: expect.any(String),
    })
    expect(injectorTableParity(destinationPath).hrcmail_delivery_intents).toEqual({
      count: 1,
      maxKey: 'EN-00001',
    })
    expect(injectorTableParity(destinationPath).wrkq_ledger_cursors).toEqual({
      count: 1,
      maxKey: 'envelope',
    })
  })

  test('admits only an HRC posture without an in-process delivery owner', () => {
    expect(() => assertInjectorAdmissible('disabled')).not.toThrow()
    expect(() => assertInjectorAdmissible('absent')).not.toThrow()
    expect(() => assertInjectorAdmissible('in-process')).toThrow('injector admission refused')
  })
})
