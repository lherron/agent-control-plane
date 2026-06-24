import { describe, expect, it } from 'bun:test'

describe('scheduler feature', () => {
  it('exports the scheduler route', async () => {
    const { schedulerRoutes } = await import('../src/features/scheduler/routes')
    expect(schedulerRoutes).toHaveLength(1)
    expect(schedulerRoutes[0]?.path).toBe('scheduler')
    expect(schedulerRoutes[0]?.children?.some((route) => route.index === true)).toBe(true)
  })
})
