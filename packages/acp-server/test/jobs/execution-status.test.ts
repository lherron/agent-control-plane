import { describe, expect, test } from 'bun:test'

import { createInMemoryJobsStore } from 'acp-jobs-store'

import { getJobExecutionStatus } from '../../src/jobs/execution-status.js'

describe('job execution status (T-06804)', () => {
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

  test('distinguishes wrong-node, federated-unassigned, disabled, and single-node implicit ownership', () => {
    const store = createInMemoryJobsStore()
    try {
      const owned = store.createJob({
        projectId: 'agent-control-plane',
        agentId: 'cody',
        scopeRef: 'agent:cody:project:agent-control-plane',
        schedule: { cron: '* * * * *' },
        input: { content: 'owned' },
        executionNodes: ['max3'],
      }).job
      const unassigned = store.createJob({
        projectId: 'agent-control-plane',
        agentId: 'cody',
        scopeRef: 'agent:cody:project:agent-control-plane',
        schedule: { cron: '* * * * *' },
        input: { content: 'unassigned' },
      }).job
      const disabled = store.createJob({
        projectId: 'agent-control-plane',
        agentId: 'cody',
        scopeRef: 'agent:cody:project:agent-control-plane',
        schedule: { cron: '* * * * *' },
        input: { content: 'disabled' },
        executionNodes: ['svc'],
        disabled: true,
      }).job
      const base = {
        jobsStore: store,
        schedulerEnabled: true,
        execEnabled: true,
      }
      const federated = {
        startupState: 'ready' as const,
        baseline: { nodeId: 'svc', mode: 'federated' as const },
        quiesced: false,
      }

      expect(getJobExecutionStatus({ ...base, job: owned, identity: federated })).toMatchObject({
        eligible: false,
        eligibilityReason: 'wrong_node',
      })
      expect(
        getJobExecutionStatus({ ...base, job: unassigned, identity: federated })
      ).toMatchObject({
        eligible: false,
        eligibilityReason: 'unassigned_federated',
      })
      expect(getJobExecutionStatus({ ...base, job: disabled, identity: federated })).toMatchObject({
        eligible: false,
        eligibilityReason: 'disabled',
      })
      expect(
        getJobExecutionStatus({
          ...base,
          job: owned,
          identity: { ...federated, current: federated.baseline, quiesced: true },
        })
      ).toMatchObject({
        eligible: false,
        eligibilityReason: 'identity_quiesced',
      })
      expect(
        getJobExecutionStatus({
          ...base,
          job: unassigned,
          identity: {
            startupState: 'ready',
            baseline: { nodeId: 'svc', mode: 'single-node' },
            quiesced: false,
          },
        })
      ).toMatchObject({
        effectiveOwnerSet: ['svc'],
        eligible: true,
        eligibilityReason: 'eligible',
      })
    } finally {
      store.close()
    }
  })
})
