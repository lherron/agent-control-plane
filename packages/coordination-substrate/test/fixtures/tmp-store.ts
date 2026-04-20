import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type CoordinationStore, openCoordinationStore } from '../../src/index.js'

export function withTmpStore<T>(run: (store: CoordinationStore, dbPath: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), 'coordination-substrate-'))
  const dbPath = join(directory, 'coordination.db')
  const store = openCoordinationStore(dbPath)

  try {
    return run(store, dbPath)
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
}
