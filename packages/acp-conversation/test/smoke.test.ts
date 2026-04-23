import { createInMemoryConversationStore } from '../src/index.js'

describe('acp-conversation smoke', () => {
  test('constructs an in-memory store', () => {
    const store = createInMemoryConversationStore()

    expect(store.migrations.applied).toContain('001_initial')

    store.close()
  })
})
