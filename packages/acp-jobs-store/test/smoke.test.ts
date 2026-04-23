import { createInMemoryJobsStore } from '../src/index.js'

describe('acp-jobs-store smoke', () => {
  test('constructs an in-memory store', () => {
    const store = createInMemoryJobsStore()

    expect(store.migrations.applied).toContain('001_initial')

    store.close()
  })
})
