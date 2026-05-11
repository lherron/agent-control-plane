import { describe, expect, it } from 'bun:test'

describe('acp-viewer', () => {
  it('App module can be imported without error', async () => {
    // Verify the App module is syntactically valid and importable.
    // Full DOM rendering is deferred — this validates the module graph.
    const mod = await import('../src/App')
    expect(mod).toBeDefined()
    expect(mod.default).toBeDefined()
  })

  it('viewer-store can be imported and initialized', async () => {
    const { useViewerStore } = await import('../src/store/viewer-store')
    expect(useViewerStore).toBeDefined()
    const state = useViewerStore.getState()
    expect(state.selectedProjectId).toBeUndefined()
    expect(state.selectedAgentId).toBeUndefined()
    expect(state.selectedJobId).toBeUndefined()
  })

  it('API types module can be imported', async () => {
    const types = await import('../src/types/api')
    expect(types).toBeDefined()
  })
})
