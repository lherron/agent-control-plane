import { createInMemoryConversationStore } from '../src/index.js'
import { listAppliedConversationStoreMigrations } from '../src/open-store.js'

describe('acp-conversation smoke', () => {
  test('constructs an in-memory store', () => {
    const store = createInMemoryConversationStore()

    expect(listAppliedConversationStoreMigrations(store.sqlite)).toContain('001_initial')

    store.close()
  })
})
