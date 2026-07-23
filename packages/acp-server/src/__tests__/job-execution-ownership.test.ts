import { describe, expect, test } from 'bun:test'

import { createInMemoryAdminStore } from 'acp-admin-store'
import { createInMemoryJobsStore } from 'acp-jobs-store'

import type { Actor } from 'acp-core'
import type { ResolvedAcpServerDeps } from '../deps.js'
import { handleRunAdminJob } from '../handlers/admin-jobs.js'
import { errorResponse } from '../http.js'

const ACTOR: Actor = { kind: 'system', id: 'test' }

describe('manual job execution owner-set admission', () => {
  test('returns a structured wrong-node conflict before creating a run or dispatching', async () => {
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
      const deps = {
        jobsStore,
        adminStore,
        defaultActor: ACTOR,
        jobNodeIdentityAuthority: {
          verifyFresh: async () => ({ ok: true as const, identity }),
          getDiagnostics: () => ({
            startupState: 'ready' as const,
            baseline: identity,
            current: identity,
            quiesced: false,
          }),
        },
      } as unknown as ResolvedAcpServerDeps

      let response: Response
      try {
        response = await handleRunAdminJob({
          request: new Request(`http://acp.local/v1/admin/jobs/${job.jobId}/run`, {
            method: 'POST',
          }),
          url: new URL(`http://acp.local/v1/admin/jobs/${job.jobId}/run`),
          params: { jobId: job.jobId },
          deps,
          actor: ACTOR,
        })
      } catch (error) {
        response = errorResponse(error)
      }

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
    } finally {
      jobsStore.close()
      adminStore.close()
    }
  })
})
