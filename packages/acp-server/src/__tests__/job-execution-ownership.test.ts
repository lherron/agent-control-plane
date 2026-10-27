import { describe, expect, test } from 'bun:test'

import { createInMemoryAdminStore } from 'acp-admin-store'
import { createInMemoryJobsStore } from 'acp-jobs-store'

import { withWiredServer } from '../../test/fixtures/wired-server.js'

describe('manual job execution owner-set admission', () => {
  test('manual run of a job owned by another node returns 409 wrong_node and creates no run', async () => {
    const jobsStore = createInMemoryJobsStore()
    const adminStore = createInMemoryAdminStore()
    try {
      const job = jobsStore.createJob({
        agentId: 'cody',
        projectId: 'agent-control-plane',
        scopeRef: 'agent:cody:project:agent-control-plane:task:T-06804',
        schedule: { cron: '0 * * * *' },
        input: { content: 'must stay on svc' },
        executionNodes: ['svc'],
      }).job
      const identity = {
        nodeId: 'max3',
        mode: 'federated' as const,
        verifiedAt: '2026-07-23T12:00:00.000Z',
      }

      await withWiredServer(
        async (fixture) => {
          const response = await fixture.request({
            method: 'POST',
            path: `/v1/admin/jobs/${job.jobId}/run`,
          })

          expect(response.status).toBe(409)
          expect(await response.json()).toEqual({
            error: {
              code: 'job_execution_wrong_node',
              message: `job ${job.jobId} is not owned by node max3`,
              details: {
                jobId: job.jobId,
                ownerSet: ['svc'],
                currentNode: 'max3',
              },
            },
          })
          expect(jobsStore.listJobRuns(job.jobId).jobRuns).toHaveLength(0)
        },
        {
          jobsStore,
          adminStore,
          jobNodeIdentityAuthority: {
            verifyFresh: async () => ({ ok: true as const, identity }),
            getDiagnostics: () => ({
              startupState: 'ready' as const,
              baseline: identity,
              current: identity,
              quiesced: false,
            }),
          } as never,
        }
      )
    } finally {
      jobsStore.close()
      adminStore.close()
    }
  })
})
