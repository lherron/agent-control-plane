import { describe, expect, it } from 'bun:test'

describe('agents feature', () => {
  it('exports list and detail routes', async () => {
    const { agentRoutes } = await import('../src/features/agents/routes')
    expect(agentRoutes).toHaveLength(1)
    expect(agentRoutes[0]?.path).toBe('agents')
    expect(agentRoutes[0]?.children?.some((route) => route.index === true)).toBe(true)
    expect(agentRoutes[0]?.children?.some((route) => route.path === ':agentId')).toBe(true)
  })

  it('imports agent tab components', async () => {
    const overview = await import('../src/features/agents/components/agent-overview-tab')
    const heartbeat = await import('../src/features/agents/components/agent-heartbeat-tab')
    expect(overview.AgentOverviewTab).toBeDefined()
    expect(heartbeat.AgentHeartbeatTab).toBeDefined()
  })
})
