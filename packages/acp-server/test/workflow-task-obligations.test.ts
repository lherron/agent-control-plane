import { describe, expect, test } from 'bun:test'

import { withWiredServer } from './fixtures/wired-server.js'

async function createTaskWithObligation(
  fixture: Awaited<Parameters<Parameters<typeof withWiredServer>[0]>[0]>
) {
  const create = await fixture.request({
    method: 'POST',
    path: '/v1/tasks',
    body: {
      projectId: fixture.seed.projectId,
      workflow: { id: 'code_defect_fastlane', version: 1 },
      goal: 'exercise obligation lifecycle HTTP routes',
      roleBindings: {
        implementer: { kind: 'agent', id: 'larry' },
        tester: { kind: 'agent', id: 'curly' },
      },
      supervisor: {
        actor: { kind: 'agent', id: 'coordinator' },
        autonomy: 'managed',
        capabilities: { createObligations: true, createWaivers: true },
      },
      idempotencyKey: 'server-obligation:create',
      actor: { agentId: 'coordinator' },
    },
  })
  expect(create.status).toBe(201)
  const created = await fixture.json<{ task: { taskId: string } }>(create)

  const action = await fixture.request({
    method: 'POST',
    path: `/v1/tasks/${created.task.taskId}/actions`,
    body: {
      supervisorRunId: 'server-supervisor-run',
      expectedTaskVersion: 0,
      capabilities: { createObligations: true },
      idempotencyKey: 'server-obligation:create-obligation',
      action: {
        type: 'create_obligation',
        kind: 'missing_evidence',
        ownerRole: 'implementer',
        summary: 'Need an explicit lifecycle decision',
        blocking: false,
      },
    },
  })
  expect(action.status).toBe(200)
  const acted = await fixture.json<{ obligation: { obligationId: string } }>(action)
  return { taskId: created.task.taskId, obligationId: acted.obligation.obligationId }
}

describe('durable workflow task obligation lifecycle routes', () => {
  test('POST waive records reason and evidenceRefs on an obligation', async () => {
    await withWiredServer(async (fixture) => {
      const { taskId, obligationId } = await createTaskWithObligation(fixture)

      const response = await fixture.request({
        method: 'POST',
        path: `/v1/tasks/${taskId}/obligations/${obligationId}/waive`,
        body: {
          actor: { kind: 'agent', id: 'coordinator' },
          reason: 'Supervisor accepted the evidence gap',
          evidenceRefs: ['artifact://waiver-note'],
          idempotencyKey: 'server-obligation:waive',
        },
      })
      const body = await fixture.json<{
        obligation: { status: string; waiverEvidenceRefs: string[] }
      }>(response)

      expect(response.status).toBe(200)
      expect(body.obligation).toMatchObject({
        status: 'waived',
        waiverEvidenceRefs: ['artifact://waiver-note'],
      })
      expect(
        fixture.stateStore.workflowRuntime.loadSnapshot().events.map((event) => event.type)
      ).toContain('obligation.waived')
    })
  })

  test('POST cancel records reason and cancelled status on an obligation', async () => {
    await withWiredServer(async (fixture) => {
      const { taskId, obligationId } = await createTaskWithObligation(fixture)

      const response = await fixture.request({
        method: 'POST',
        path: `/v1/tasks/${taskId}/obligations/${obligationId}/cancel`,
        body: {
          actor: { kind: 'agent', id: 'coordinator' },
          reason: 'Superseded by a new supervisor path',
          idempotencyKey: 'server-obligation:cancel',
        },
      })
      const body = await fixture.json<{ obligation: { status: string; cancelReason: string } }>(
        response
      )

      expect(response.status).toBe(200)
      expect(body.obligation).toMatchObject({
        status: 'cancelled',
        cancelReason: 'Superseded by a new supervisor path',
      })
      expect(
        fixture.stateStore.workflowRuntime.loadSnapshot().events.map((event) => event.type)
      ).toContain('obligation.cancelled')
    })
  })
})
