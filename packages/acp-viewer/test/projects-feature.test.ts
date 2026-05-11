import { describe, expect, it } from 'bun:test'

describe('projects feature', () => {
  it('exports list and detail routes', async () => {
    const { projectRoutes } = await import('../src/features/projects/routes')
    expect(projectRoutes).toHaveLength(1)
    expect(projectRoutes[0]?.path).toBe('projects')
    expect(projectRoutes[0]?.children?.some((route) => route.index === true)).toBe(true)
    expect(projectRoutes[0]?.children?.some((route) => route.path === ':projectId')).toBe(true)
  })

  it('imports project tab components', async () => {
    const overview = await import('../src/features/projects/components/project-overview-tab')
    const jobs = await import('../src/features/projects/components/project-jobs-tab')
    expect(overview.ProjectOverviewTab).toBeDefined()
    expect(jobs.ProjectJobsTab).toBeDefined()
  })
})
