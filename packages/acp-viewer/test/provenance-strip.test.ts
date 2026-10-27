import { describe, expect, it } from 'bun:test'

describe('provenance-strip', () => {
  it('ProvenanceStrip module can be imported', async () => {
    const mod = await import('../src/components/provenance-strip')
    expect(mod).toBeDefined()
    expect(mod.ProvenanceStrip).toBeDefined()
    expect(typeof mod.ProvenanceStrip).toBe('function')
  })
})
