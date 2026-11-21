import { describe, expect, test } from 'bun:test'

import { createInMemoryAdminStore } from 'acp-admin-store'
import { createInMemoryJobsStore } from 'acp-jobs-store'

import { withWiredServer } from '../../test/fixtures/wired-server.js'

describe('manual event job admission', () => {
  test('manual run of a disabled event job returns 409 and creates no run', async () => {
    const jobsStore = createInMemoryJobsStore()
    const adminStore = createInMemoryAdminStore()
    try {
      const job = jobsStore.createJob({
        agentId: 'cody',
        projectId: 'agent-control-plane',
        scopeRef: 'agent:cody:project:agent-control-plane:task:T-06804',
        trigger: { kind: 'event', source: 'wrkq', match: { event: 'created' } },
        input: { content: 'disabled smoke fixture' },
        disabled: true,
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
              code: 'job_execution_disabled',
              message: `job ${job.jobId} is disabled`,
              details: {
                jobId: job.jobId,
                ownerSet: null,
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
