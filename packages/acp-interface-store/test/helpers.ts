import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openInterfaceStore } from '../src/index.js'

export function withInterfaceStore(testFn: ReturnType<typeof createHarness>): void {
  createHarness()(testFn)
}

function createHarness() {
  return (
    testFn: (fixture: { dbPath: string; store: ReturnType<typeof openInterfaceStore> }) => void
  ) => {
    const directory = mkdtempSync(join(tmpdir(), 'acp-interface-store-'))
    const dbPath = join(directory, 'interface.sqlite')
    const store = openInterfaceStore({ dbPath, actor: { agentId: 'cody' } })

    try {
      testFn({ dbPath, store })
    } finally {
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }
}
