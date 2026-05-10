import { describe, expect, test } from 'bun:test'

import { withWiredServer } from './fixtures/wired-server.js'

type PatchSummary = {
  proposalId: string
  baseWorkflow: { id: string; version: number; hash: string }
  patchKind: string
  status: string
  createdBy: { kind: string; id: string }
  createdAt: string
  sourceAnomalyIds: string[]
  rationaleSummary: string
  patch?: unknown
}

type PatchProposal = PatchSummary & {
  taskId: string
  patch: unknown
  replayExpectations: unknown
}

async function createTaskWithPatchProposal(
  fixture: Parameters<Parameters<typeof withWiredServer>[0]>[0],
  input: { taskId: string; idempotencyPrefix: string; patchKind?: string | undefined }
): Promise<{ taskId: string; proposalId: string }> {
  const create = await fixture.request({
    method: 'POST',
    path: '/v1/tasks',
    body: {
      taskId: input.taskId,
      projectId: fixture.seed.projectId,
      workflow: { id: 'basic', version: 1 },
      goal: `review patch proposal ${input.taskId}`,
      roleBindings: { owner: { kind: 'agent', id: 'larry' } },
      supervisor: {
        actor: { kind: 'agent', id: 'rex' },
        autonomy: 'managed',
        capabilities: { proposeWorkflowPatches: true },
      },
      idempotencyKey: `${input.idempotencyPrefix}:create`,
      actor: { agentId: 'rex' },
    },
  })
  expect(create.status).toBe(201)

  const action = await fixture.request({
    method: 'POST',
    path: `/v1/tasks/${input.taskId}/actions`,
    body: {
      supervisorRunId: `${input.idempotencyPrefix}:supervisor`,
      expectedTaskVersion: 0,
      capabilities: { proposeWorkflowPatches: true },
      idempotencyKey: `${input.idempotencyPrefix}:propose`,
      action: {
        type: 'propose_workflow_patch',
        category: 'no_legal_transition',
        summary: 'The workflow needs an explicit retry lane.',
        proposedRecovery: 'Add a retry transition with evidence requirements.',
        patchKind: input.patchKind ?? 'add_transition',
        patch: {
          transitionId: 'retry_verify',
          from: { status: 'waiting', phase: 'qa_inconclusive' },
          to: { status: 'active', phase: 'doing' },
          requires: [{ type: 'evidence', kinds: ['retry_plan'] }],
        },
        rationaleSummary: 'Repeated inconclusive verification should be modeled explicitly.',
      },
    },
  })
  expect(action.status).toBe(200)

  const snapshot = fixture.stateStore.workflowRuntime.loadSnapshot()
  const proposal = snapshot.patchProposals.find((candidate) => candidate.taskId === input.taskId)
  expect(proposal).toBeDefined()
  return { taskId: input.taskId, proposalId: proposal?.proposalId ?? '' }
}

describe('workflow patch proposal read routes', () => {
  test('lists proposal summaries for a task without exposing the full patch payload', async () => {
    await withWiredServer(async (fixture) => {
      const first = await createTaskWithPatchProposal(fixture, {
        taskId: 'T-PATCH-READ-1',
        idempotencyPrefix: 'patch-read-1',
      })
      await createTaskWithPatchProposal(fixture, {
        taskId: 'T-PATCH-READ-2',
        idempotencyPrefix: 'patch-read-2',
      })

      const response = await fixture.request({
        method: 'GET',
        path: `/v1/tasks/${first.taskId}/workflow-patch-proposals`,
      })
      const body = await fixture.json<{ proposals: PatchSummary[] }>(response)

      expect(response.status).toBe(200)
      expect(body.proposals).toEqual([
        expect.objectContaining({
          proposalId: first.proposalId,
          baseWorkflow: expect.objectContaining({ id: 'basic', version: 1 }),
          patchKind: 'add_transition',
          status: 'proposed',
          createdBy: { kind: 'agent', id: 'rex' },
          sourceAnomalyIds: [expect.stringMatching(/^anom_/)],
          rationaleSummary: 'Repeated inconclusive verification should be modeled explicitly.',
        }),
      ])
      expect(body.proposals[0]).not.toHaveProperty('patch')
    })
  })

  test('filters proposal list by status and applies limit', async () => {
    await withWiredServer(async (fixture) => {
      const first = await createTaskWithPatchProposal(fixture, {
        taskId: 'T-PATCH-FILTER',
        idempotencyPrefix: 'patch-filter-1',
      })
      const second = await createTaskWithPatchProposal(fixture, {
        taskId: 'T-PATCH-FILTER-OTHER',
        idempotencyPrefix: 'patch-filter-2',
        patchKind: 'change_requirement',
      })
      fixture.stateStore.sqlite
        .prepare(
          'UPDATE workflow_patch_proposals SET task_id = ?, status = ? WHERE proposal_id = ?'
        )
        .run(first.taskId, 'accepted', second.proposalId)

      const response = await fixture.request({
        method: 'GET',
        path: `/v1/tasks/${first.taskId}/workflow-patch-proposals?status=accepted&limit=1`,
      })
      const body = await fixture.json<{ proposals: PatchSummary[] }>(response)

      expect(response.status).toBe(200)
      expect(body.proposals).toHaveLength(1)
      expect(body.proposals[0]).toEqual(
        expect.objectContaining({
          proposalId: second.proposalId,
          status: 'accepted',
          patchKind: 'change_requirement',
        })
      )
    })
  })

  test('shows the full proposal record and returns 404 for an unknown proposal id', async () => {
    await withWiredServer(async (fixture) => {
      const created = await createTaskWithPatchProposal(fixture, {
        taskId: 'T-PATCH-SHOW',
        idempotencyPrefix: 'patch-show',
      })

      const response = await fixture.request({
        method: 'GET',
        path: `/v1/workflow-patch-proposals/${created.proposalId}`,
      })
      const body = await fixture.json<{ proposal: PatchProposal }>(response)

      expect(response.status).toBe(200)
      expect(body.proposal).toEqual(
        expect.objectContaining({
          proposalId: created.proposalId,
          taskId: created.taskId,
          patch: expect.objectContaining({ transitionId: 'retry_verify' }),
          replayExpectations: expect.anything(),
        })
      )

      const missing = await fixture.request({
        method: 'GET',
        path: '/v1/workflow-patch-proposals/wpp_missing',
      })
      expect(missing.status).toBe(404)
    })
  })
})
