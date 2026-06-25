import {
  createInMemoryConversationStore,
  listAppliedConversationStoreMigrations,
} from '../src/index.js'

describe('acp-conversation smoke', () => {
  test('constructs an in-memory store', () => {
    const store = createInMemoryConversationStore()

    expect(listAppliedConversationStoreMigrations(store.sqlite)).toContain('001_initial')

    store.close()
  })
})
