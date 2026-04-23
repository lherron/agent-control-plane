import { createInMemoryAdminStore } from '../src/index.js'

describe('acp-admin-store smoke', () => {
  test('constructs an in-memory store', () => {
    const store = createInMemoryAdminStore()

    expect(store.migrations.applied).toContain('001_initial')

    store.close()
  })
})
