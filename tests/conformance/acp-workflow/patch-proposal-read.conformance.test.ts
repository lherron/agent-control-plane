import { describe, expect, test } from 'bun:test'

import { withWiredServer } from '../../../packages/acp-server/test/fixtures/wired-server.js'

describe('ACP workflow patch proposal read conformance', () => {
  test('creates a patch proposal through supervisor action, then lists and shows it through read APIs', async () => {
    await withWiredServer(async (fixture) => {
      const taskId = 'T-CONFORMANCE-PATCH'
      const create = await fixture.request({
        method: 'POST',
        path: '/v1/tasks',
        body: {
          taskId,
          projectId: fixture.seed.projectId,
          workflow: { id: 'basic', version: 1 },
          goal: 'prove patch proposals are reviewable',
          roleBindings: { owner: { kind: 'agent', id: 'larry' } },
          supervisor: {
            actor: { kind: 'agent', id: 'rex' },
            autonomy: 'managed',
            capabilities: { proposeWorkflowPatches: true },
          },
          idempotencyKey: 'patch-conformance:create',
          actor: { agentId: 'rex' },
        },
      })
      expect(create.status).toBe(201)

      const propose = await fixture.request({
        method: 'POST',
        path: `/v1/tasks/${taskId}/actions`,
        body: {
          supervisorRunId: 'patch-conformance:supervisor',
          expectedTaskVersion: 0,
          capabilities: { proposeWorkflowPatches: true },
          idempotencyKey: 'patch-conformance:propose',
          action: {
            type: 'propose_workflow_patch',
            category: 'state_model_gap',
            summary: 'No modeled path for returning from blocked review.',
            patchKind: 'state_model_refinement',
            patch: { addPhase: 'review_blocked', resumeTransitionId: 'resume_review' },
            rationaleSummary: 'Review blocked/resume behavior should be replayable.',
          },
        },
      })
      expect(propose.status).toBe(200)

      const stored = fixture.stateStore.workflowRuntime.loadSnapshot().patchProposals[0]
      expect(stored).toBeDefined()

      const list = await fixture.request({
        method: 'GET',
        path: `/v1/tasks/${taskId}/workflow-patch-proposals?status=proposed&limit=10`,
      })
      const listBody = await fixture.json<{ proposals: Array<Record<string, unknown>> }>(list)
      expect(list.status).toBe(200)
      expect(listBody.proposals).toEqual([
        expect.objectContaining({
          proposalId: stored?.proposalId,
          patchKind: 'state_model_refinement',
          status: 'proposed',
          rationaleSummary: 'Review blocked/resume behavior should be replayable.',
        }),
      ])
      expect(listBody.proposals[0]).not.toHaveProperty('patch')

      const show = await fixture.request({
        method: 'GET',
        path: `/v1/workflow-patch-proposals/${stored?.proposalId}`,
      })
      const showBody = await fixture.json<{ proposal: Record<string, unknown> }>(show)
      expect(show.status).toBe(200)
      expect(showBody.proposal).toEqual(
        expect.objectContaining({
          proposalId: stored?.proposalId,
          taskId,
          patch: { addPhase: 'review_blocked', resumeTransitionId: 'resume_review' },
          replayExpectations: expect.anything(),
        })
      )
    })
  })
})
