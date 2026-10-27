import { describe, expect, it } from 'bun:test'

describe('acp-viewer', () => {
  it('App module can be imported without error', async () => {
    // Verify the App module is syntactically valid and importable.
    // Full DOM rendering is deferred — this validates the module graph.
    const mod = await import('../src/App')
    expect(mod).toBeDefined()
    expect(mod.default).toBeDefined()
  })
})
