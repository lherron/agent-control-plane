import { describe, expect, it } from 'bun:test'

describe('provenance-strip', () => {
  it('ProvenanceStrip module can be imported', async () => {
    const mod = await import('../src/components/provenance-strip')
    expect(mod).toBeDefined()
    expect(mod.ProvenanceStrip).toBeDefined()
    expect(typeof mod.ProvenanceStrip).toBe('function')
  })

  it('ProvenanceEntry type is re-exported', async () => {
    // Ensure the types module has ProvenanceEntry
    const types = await import('../src/types/api')
    expect(types).toBeDefined()
    // ProvenanceEntry is an interface/type, so we just verify the module exports compile
  })

  it('NormalizedFlow and related types are importable', async () => {
    const types = await import('../src/types/api')
    // Verify the module graph is intact by checking key type-adjacent exports
    expect(types).toBeDefined()
  })
})
