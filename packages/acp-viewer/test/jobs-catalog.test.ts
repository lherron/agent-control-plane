import { describe, expect, it } from 'bun:test'

describe('jobs-catalog', () => {
  it('routes module exports jobRoutes array', async () => {
    const mod = await import('../src/features/jobs/routes')
    expect(mod).toBeDefined()
    expect(Array.isArray(mod.jobRoutes)).toBe(true)
    expect(mod.jobRoutes.length).toBeGreaterThan(0)

    // Should have a 'jobs' parent path
    const jobsRoute = mod.jobRoutes[0]
    expect(jobsRoute.path).toBe('jobs')
    expect(jobsRoute.children).toBeDefined()
    expect(jobsRoute.children!.length).toBe(3) // index, :jobId, :jobId/flow
  })
})
