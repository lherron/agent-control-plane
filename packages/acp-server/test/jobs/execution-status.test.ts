import { afterEach, describe, expect, test } from 'bun:test'

import { createInMemoryJobsStore } from 'acp-jobs-store'

import { getJobExecutionStatus } from '../../src/jobs/execution-status.js'
import { withWiredServer } from '../fixtures/wired-server.js'

const originalSchedulerEnabled = process.env['ACP_SCHEDULER_ENABLED']

afterEach(() => {
  if (originalSchedulerEnabled === undefined) {
    process.env['ACP_SCHEDULER_ENABLED'] = undefined
  } else {
    process.env['ACP_SCHEDULER_ENABLED'] = originalSchedulerEnabled
  }
})

type IdentityDiagnostics = {
  startupState: 'ready'
  baseline: { nodeId: string; mode: 'federated' | 'single-node' }
  current?: { nodeId: string; mode: 'federated' | 'single-node' } | undefined
  quiesced: boolean
}

describe('job execution status (T-06804)', () => {
  test('GET /v1/admin/jobs/scheduler reports wrong-node, federated-unassigned, disabled, quiesced, and single-node implicit eligibility', async () => {
    process.env['ACP_SCHEDULER_ENABLED'] = '1'
    const jobsStore = createInMemoryJobsStore()
    try {
      const owned = jobsStore.createJob({
        projectId: 'agent-control-plane',
        agentId: 'cody',
        scopeRef: 'agent:cody:project:agent-control-plane',
        schedule: { cron: '* * * * *' },
        input: { content: 'owned' },
        executionNodes: ['max3'],
      }).job
      const unassigned = jobsStore.createJob({
        projectId: 'agent-control-plane',
        agentId: 'cody',
        scopeRef: 'agent:cody:project:agent-control-plane',
        schedule: { cron: '* * * * *' },
        input: { content: 'unassigned' },
      }).job
      const disabled = jobsStore.createJob({
        projectId: 'agent-control-plane',
        agentId: 'cody',
        scopeRef: 'agent:cody:project:agent-control-plane',
        schedule: { cron: '* * * * *' },
        input: { content: 'disabled' },
        executionNodes: ['svc'],
        disabled: true,
      }).job

      const federated: IdentityDiagnostics = {
        startupState: 'ready',
        baseline: { nodeId: 'svc', mode: 'federated' },
        quiesced: false,
      }
      let identity: IdentityDiagnostics = federated

      await withWiredServer(
        async (fixture) => {
          const readExecution = async (): Promise<Map<string, Record<string, unknown>>> => {
            const response = await fixture.request({
              method: 'GET',
              path: '/v1/admin/jobs/scheduler',
            })
            expect(response.status).toBe(200)
            const body = await fixture.json<{
              jobs: Array<{ jobId: string; execution: Record<string, unknown> }>
            }>(response)
            return new Map(body.jobs.map((job) => [job.jobId, job.execution]))
          }

          const federatedView = await readExecution()
          expect(federatedView.get(owned.jobId)).toMatchObject({
            eligible: false,
            eligibilityReason: 'wrong_node',
          })
          expect(federatedView.get(unassigned.jobId)).toMatchObject({
            eligible: false,
            eligibilityReason: 'unassigned_federated',
          })
          expect(federatedView.get(disabled.jobId)).toMatchObject({
            eligible: false,
            eligibilityReason: 'disabled',
          })

          identity = { ...federated, current: federated.baseline, quiesced: true }
          expect((await readExecution()).get(owned.jobId)).toMatchObject({
            eligible: false,
            eligibilityReason: 'identity_quiesced',
          })

          identity = {
            startupState: 'ready',
            baseline: { nodeId: 'svc', mode: 'single-node' },
            quiesced: false,
          }
          expect((await readExecution()).get(unassigned.jobId)).toMatchObject({
            effectiveOwnerSet: ['svc'],
            eligible: true,
            eligibilityReason: 'eligible',
          })
        },
        {
          jobsStore,
          jobExecPolicy: {
            enabled: true,
            allowedCwdRoots: [],
            defaultTimeoutMs: 1_000,
            maxTimeoutMs: 1_000,
            defaultMaxOutputBytes: 1_024,
            maxOutputBytes: 1_024,
            inheritEnvAllowlist: [],
          },
          jobNodeIdentityAuthority: {
            getDiagnostics: () => identity,
          } as never,
        }
      )
    } finally {
      jobsStore.close()
    }
  })
})

describe('multi-owner execution status', () => {
  test('reports node membership, local inflight work, and owned capability gaps', () => {
    const store = createInMemoryJobsStore()
    try {
      const job = store.createJob({
        projectId: 'agent-control-plane',
        agentId: 'cody',
        scopeRef: 'agent:cody:project:agent-control-plane',
        schedule: { cron: '* * * * *' },
        input: { content: 'status' },
        executionNodes: ['max3', 'svc'],
        flow: {
          sequence: [{ id: 'exec', kind: 'exec', exec: { argv: ['true'] } }],
        },
      }).job
      store.createJobRun(
        job.jobId,
        {
          triggeredAt: '2026-07-23T01:00:00.000Z',
          triggeredBy: 'manual',
          status: 'dispatched',
        },
        {
          nodeId: 'svc',
          mode: 'federated',
          verifiedAt: '2026-07-23T01:00:00.000Z',
        }
      )

      expect(
        getJobExecutionStatus({
          jobsStore: store,
          job,
          identity: {
            startupState: 'ready',
            baseline: { nodeId: 'svc', mode: 'federated' },
            current: { nodeId: 'svc', mode: 'federated' },
            quiesced: false,
          },
          schedulerEnabled: false,
          execEnabled: false,
        })
      ).toEqual({
        currentNode: 'svc',
        mode: 'federated',
        ownerSet: ['max3', 'svc'],
        effectiveOwnerSet: ['max3', 'svc'],
        eligible: true,
        eligibilityReason: 'eligible',
        inflightCount: 1,
        localInflightCount: 1,
        ownedButIncapable: ['scheduler_disabled', 'exec_disabled'],
      })
    } finally {
      store.close()
    }
  })
})
