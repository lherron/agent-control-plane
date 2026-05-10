import { describe, expect, test } from 'bun:test'

import { withWiredServer } from './fixtures/wired-server.js'

async function createTaskWithObligation(
  fixture: Awaited<Parameters<Parameters<typeof withWiredServer>[0]>[0]>,
  capabilities: { createObligations: boolean; createWaivers?: boolean | undefined } = {
    createObligations: true,
    createWaivers: true,
  }
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
        capabilities,
      },
      idempotencyKey: 'server-obligation:create',
      actor: { agentId: 'coordinator' },
    },
  })
  expect(create.status).toBe(201)
  const created = await fixture.json<{ task: { taskId: string } }>(create)

  const startRun = await fixture.request({
    method: 'POST',
    path: '/v1/workflow-supervisor-runs',
    body: {
      taskId: created.task.taskId,
      runId: 'server-supervisor-run',
      supervisor: { kind: 'agent', id: 'coordinator' },
      autonomy: 'managed',
      capabilities,
      idempotencyKey: 'server-obligation:supervisor:start',
      actor: { agentId: 'coordinator' },
    },
  })
  expect(startRun.status).toBe(200)

  const action = await fixture.request({
    method: 'POST',
    path: `/v1/tasks/${created.task.taskId}/actions`,
    body: {
      supervisorRunId: 'server-supervisor-run',
      expectedTaskVersion: 0,
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

async function attachWaiverEvidence(
  fixture: Awaited<Parameters<Parameters<typeof withWiredServer>[0]>[0]>,
  taskId: string,
  idempotencyKey: string
): Promise<string> {
  const response = await fixture.request({
    method: 'POST',
    path: `/v1/tasks/${taskId}/evidence`,
    body: {
      actor: { kind: 'agent', id: 'coordinator' },
      evidence: [
        { kind: 'evidence_override', ref: `artifact://${idempotencyKey}`, summary: 'done' },
      ],
      idempotencyKey,
    },
  })
  expect(response.status).toBe(201)
  const body = await fixture.json<{ evidence: Array<{ evidenceId: string }> }>(response)
  const evidenceId = body.evidence[0]?.evidenceId
  if (evidenceId === undefined) {
    throw new Error('evidence was not attached')
  }
  return evidenceId
}

describe('durable workflow task obligation lifecycle routes', () => {
  test('POST waive records reason and evidenceRefs on an obligation', async () => {
    await withWiredServer(async (fixture) => {
      const { taskId, obligationId } = await createTaskWithObligation(fixture)
      const waiverEvidenceId = await attachWaiverEvidence(
        fixture,
        taskId,
        'server-obligation:evidence'
      )

      const response = await fixture.request({
        method: 'POST',
        path: `/v1/tasks/${taskId}/obligations/${obligationId}/waive`,
        body: {
          actor: { kind: 'agent', id: 'coordinator' },
          reason: 'Supervisor accepted the evidence gap',
          evidenceRefs: [waiverEvidenceId],
          idempotencyKey: 'server-obligation:waive',
        },
      })
      const body = await fixture.json<{
        obligation: { status: string; waiverEvidenceRefs: string[] }
      }>(response)

      expect(response.status).toBe(200)
      expect(body.obligation).toMatchObject({
        status: 'waived',
        waiverEvidenceRefs: [waiverEvidenceId],
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

  test('POST waive returns 403 when persisted supervisor run lacks createWaivers', async () => {
    await withWiredServer(async (fixture) => {
      const { taskId, obligationId } = await createTaskWithObligation(fixture, {
        createObligations: true,
      })

      const response = await fixture.request({
        method: 'POST',
        path: `/v1/tasks/${taskId}/obligations/${obligationId}/waive`,
        body: {
          actor: { kind: 'agent', id: 'coordinator' },
          supervisorRunId: 'server-supervisor-run',
          reason: 'Supervisor run lacks waiver authority',
          idempotencyKey: 'server-obligation:waive:no-create-waivers',
        },
      })

      expect(response.status).toBe(403)
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'capability_not_granted' },
      })
    })
  })

  test('POST waive returns 422 when waiver evidence refs include a missing evidence id', async () => {
    await withWiredServer(async (fixture) => {
      const { taskId, obligationId } = await createTaskWithObligation(fixture)

      const response = await fixture.request({
        method: 'POST',
        path: `/v1/tasks/${taskId}/obligations/${obligationId}/waive`,
        body: {
          actor: { kind: 'agent', id: 'coordinator' },
          supervisorRunId: 'server-supervisor-run',
          reason: 'References a missing evidence record',
          evidenceRefs: ['evd_missing_waiver'],
          idempotencyKey: 'server-obligation:waive:missing-evidence',
        },
      })

      expect(response.status).toBe(422)
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'evidence_not_found' },
      })
    })
  })
})
