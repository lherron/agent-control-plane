import { describe, expect, test } from 'bun:test'

import { applyManagedJob, createInMemoryJobsStore } from 'acp-jobs-store'

import { withWiredServer } from './fixtures/wired-server.js'

describe('managed-resource execution status (T-06804)', () => {
  test('reports desired hash, HRC node membership, inflight ownership, and capability gaps', async () => {
    const jobsStore = createInMemoryJobsStore()
    const originalSchedulerEnabled = process.env['ACP_SCHEDULER_ENABLED']
    process.env['ACP_SCHEDULER_ENABLED'] = '0'
    try {
      const ownerScopeRef = 'agent:cody:project:agent-control-plane'
      const desiredProjectionHash = `sha256-canonical-json/v1:${'a'.repeat(64)}`
      const applied = applyManagedJob(jobsStore, {
        projectionId: 'agent-directory:agent:cody:project:agent-control-plane:scheduled-job:status',
        projectionPk: 'agent-cody.status',
        sourceOwnerScopeRef: ownerScopeRef,
        resourceName: 'status',
        sourcePath: 'agents/cody/schedules/status.toml',
        sourceHash: `sha256-canonical-json/v1:${'b'.repeat(64)}`,
        desiredProjectionHash,
        resourceKind: 'scheduled-job',
        desiredJson: {
          kind: 'scheduled-job',
          slug: 'agent-cody.status',
          projectId: 'agent-control-plane',
          agentId: 'cody',
          scopeRef: ownerScopeRef,
          laneRef: 'main',
          disabled: false,
          trigger: { kind: 'schedule' },
          schedule: { cron: '* * * * *' },
          execution: { nodes: ['svc'] },
          input: { content: 'status' },
          flow: {
            sequence: [{ id: 'exec', kind: 'exec', exec: { argv: ['true'] } }],
          },
        },
        now: '2026-07-23T01:00:00.000Z',
      })
      expect(applied.outcome).toBe('created')
      if (applied.outcome !== 'created') return
      jobsStore.createJobRun(
        applied.job.jobId,
        {
          triggeredAt: '2026-07-23T01:01:00.000Z',
          triggeredBy: 'manual',
          status: 'dispatched',
        },
        {
          nodeId: 'svc',
          mode: 'federated',
          verifiedAt: '2026-07-23T01:01:00.000Z',
        }
      )

      await withWiredServer(
        async (fixture) => {
          const response = await fixture.request({
            method: 'POST',
            path: '/v1/admin/managed-resources/status',
            body: { ownerScopeRef },
          })
          expect(response.status).toBe(200)
          const body = await fixture.json<{
            resources: Array<Record<string, unknown>>
            executionContext: Record<string, unknown>
          }>(response)
          expect(body.executionContext).toMatchObject({
            schedulerEnabled: false,
            execEnabled: false,
            identity: {
              baseline: { nodeId: 'svc', mode: 'federated' },
            },
          })
          expect(body.resources[0]).toMatchObject({
            desiredProjectionHash,
            disabled: false,
            execution: {
              currentNode: 'svc',
              mode: 'federated',
              ownerSet: ['svc'],
              effectiveOwnerSet: ['svc'],
              eligible: true,
              eligibilityReason: 'eligible',
              inflightCount: 1,
              localInflightCount: 1,
              ownedButIncapable: ['scheduler_disabled', 'exec_disabled'],
            },
          })
        },
        {
          jobsStore,
          jobExecPolicy: {
            enabled: false,
            allowedCwdRoots: [],
            defaultTimeoutMs: 1_000,
            maxTimeoutMs: 1_000,
            defaultMaxOutputBytes: 1_024,
            maxOutputBytes: 1_024,
            inheritEnvAllowlist: [],
          },
          jobNodeIdentityAuthority: {
            getDiagnostics: () => ({
              startupState: 'ready',
              baseline: { nodeId: 'svc', mode: 'federated' },
              current: { nodeId: 'svc', mode: 'federated' },
              quiesced: false,
            }),
          } as never,
        }
      )
    } finally {
      process.env['ACP_SCHEDULER_ENABLED'] = originalSchedulerEnabled
      jobsStore.close()
    }
  })
})
