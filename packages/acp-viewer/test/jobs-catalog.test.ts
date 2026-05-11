import { describe, expect, it } from 'bun:test'

describe('jobs-catalog', () => {
  it('JobsCatalog module can be imported', async () => {
    const mod = await import('../src/features/jobs/pages/jobs-catalog')
    expect(mod).toBeDefined()
    expect(mod.JobsCatalog).toBeDefined()
    expect(typeof mod.JobsCatalog).toBe('function')
  })

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

  it('tab components can be imported', async () => {
    const overview = await import('../src/features/jobs/components/job-overview-tab')
    const startup = await import('../src/features/jobs/components/job-startup-tab')
    const schedule = await import('../src/features/jobs/components/job-schedule-tab')
    const flow = await import('../src/features/jobs/components/job-flow-tab')
    const runs = await import('../src/features/jobs/components/job-runs-tab')
    const raw = await import('../src/features/jobs/components/job-raw-tab')

    expect(overview.JobOverviewTab).toBeDefined()
    expect(startup.JobStartupTab).toBeDefined()
    expect(schedule.JobScheduleTab).toBeDefined()
    expect(flow.JobFlowTab).toBeDefined()
    expect(runs.JobRunsTab).toBeDefined()
    expect(raw.JobRawTab).toBeDefined()
  })
})
