import { describe, expect, it } from 'bun:test'

describe('agents feature', () => {
  it('exports list and detail routes', async () => {
    const { agentRoutes } = await import('../src/features/agents/routes')
    expect(agentRoutes).toHaveLength(1)
    expect(agentRoutes[0]?.path).toBe('agents')
    expect(agentRoutes[0]?.children?.some((route) => route.index === true)).toBe(true)
    expect(agentRoutes[0]?.children?.some((route) => route.path === ':agentId')).toBe(true)
  })
})
