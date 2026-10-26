import { test } from 'bun:test'

import { openUnderForeignWriterLock } from '../../acp-core/test/fixtures/sqlite-writer-lock.js'
import { openKickerStateStore } from '../src/policy/index.js'

test('open waits out a writer lock held by another process', async () => {
  await openUnderForeignWriterLock((dbPath) => openKickerStateStore(dbPath))
})
