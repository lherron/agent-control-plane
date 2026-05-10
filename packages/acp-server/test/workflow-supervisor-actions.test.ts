import { describe, expect, test } from 'bun:test'

import type { WiredServerFixture } from './fixtures/wired-server.js'
import { withWiredServer } from './fixtures/wired-server.js'

const owner = { kind: 'agent', id: 'larry' } as const
const supervisor = { kind: 'agent', id: 'rex' } as const
const otherSupervisor = { kind: 'agent', id: 'clod' } as const

async function createTask(fixture: WiredServerFixture, id = 'default'): Promise<string> {
  const response = await fixture.request({
    method: 'POST',
    path: '/v1/tasks',
    body: {
      projectId: fixture.seed.projectId,
      workflow: { id: 'basic', version: 1 },
      goal: 'exercise supervisor actions',
      roleBindings: { owner },
      supervisor: {
        actor: supervisor,
        autonomy: 'managed',
        capabilities: {},
      },
      idempotencyKey: `server-supervisor-actions:create:${id}`,
      actor: { agentId: 'rex' },
    },
  })
  const body = await fixture.json<{ task: { taskId: string } }>(response)
  expect(response.status).toBe(201)
  return body.task.taskId
}

async function startSupervisorRun(
  fixture: WiredServerFixture,
  taskId: string,
  capabilities: Record<string, unknown>,
  runId = 'server-supervisor-run',
  actor = supervisor
): Promise<string> {
  const response = await fixture.request({
    method: 'POST',
    path: '/v1/workflow-supervisor-runs',
    body: {
      taskId,
      runId,
      supervisor: actor,
      autonomy: 'managed',
      capabilities,
      idempotencyKey: `server-supervisor-actions:start:${runId}`,
      actor: { agentId: actor.id },
    },
  })
  expect(response.status).toBe(200)
  return runId
}

describe('workflow supervisor action routes', () => {
  test('ignores request-body capabilities and derives authorization from the persisted supervisor run', async () => {
    await withWiredServer(async (fixture) => {
      const taskId = await createTask(fixture)
      const runId = await startSupervisorRun(fixture, taskId, {})

      const response = await fixture.request({
        method: 'POST',
        path: `/v1/tasks/${taskId}/actions`,
        body: {
          supervisorRunId: runId,
          actor: supervisor,
          capabilities: { createObligations: true },
          action: {
            type: 'create_obligation',
            kind: 'missing_evidence',
            summary: 'request body must not grant capabilities',
          },
          idempotencyKey: 'server-supervisor-actions:body-capability',
        },
      })

      expect(response.status).toBe(422)
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'capability_not_granted' },
      })
    })
  })

  test('rejects actor mismatch and supervisor runs from another task', async () => {
    await withWiredServer(async (fixture) => {
      const taskId = await createTask(fixture, 'auth-primary')
      const otherTaskId = await createTask(fixture, 'auth-other')
      const runId = await startSupervisorRun(
        fixture,
        taskId,
        { createObligations: true },
        'server-supervisor-run-auth'
      )

      const actorMismatch = await fixture.request({
        method: 'POST',
        path: `/v1/tasks/${taskId}/actions`,
        body: {
          supervisorRunId: runId,
          actor: otherSupervisor,
          action: {
            type: 'create_obligation',
            kind: 'missing_evidence',
            summary: 'wrong actor',
          },
          idempotencyKey: 'server-supervisor-actions:actor-mismatch',
        },
      })
      expect(actorMismatch.status).toBe(422)
      await expect(actorMismatch.json()).resolves.toMatchObject({
        error: { code: 'authority_not_granted' },
      })

      const wrongTask = await fixture.request({
        method: 'POST',
        path: `/v1/tasks/${otherTaskId}/actions`,
        body: {
          supervisorRunId: runId,
          actor: supervisor,
          capabilities: { createObligations: true },
          action: {
            type: 'create_obligation',
            kind: 'missing_evidence',
            summary: 'wrong task',
          },
          idempotencyKey: 'server-supervisor-actions:wrong-task',
        },
      })
      expect(wrongTask.status).toBe(422)
      await expect(wrongTask.json()).resolves.toMatchObject({
        error: { code: 'authority_not_granted' },
      })
    })
  })

  test('AttachEvidence action persists evidence through the workflow evidence path with supervisor provenance', async () => {
    await withWiredServer(async (fixture) => {
      const taskId = await createTask(fixture)
      const runId = await startSupervisorRun(
        fixture,
        taskId,
        { attachEvidence: true },
        'server-supervisor-run-attach'
      )

      const response = await fixture.request({
        method: 'POST',
        path: `/v1/tasks/${taskId}/actions`,
        body: {
          supervisorRunId: runId,
          actor: supervisor,
          action: {
            type: 'attach_evidence',
            evidence: [{ kind: 'completion_note', ref: 'artifact://note', summary: 'done' }],
          },
          idempotencyKey: 'server-supervisor-actions:attach',
        },
      })

      expect(response.status).toBe(200)
      const snapshot = fixture.stateStore.workflowRuntime.loadSnapshot()
      expect(snapshot.evidence).toContainEqual(
        expect.objectContaining({
          kind: 'completion_note',
          ref: 'artifact://note',
          supervisorRunId: runId,
        })
      )
      expect(snapshot.events).toContainEqual(
        expect.objectContaining({
          type: 'evidence.attached',
          supervisorRunId: runId,
        })
      )
    })
  })

  test('PauseSupervision blocks later actions until UnpauseSupervision resumes the run', async () => {
    await withWiredServer(async (fixture) => {
      const taskId = await createTask(fixture)
      const runId = await startSupervisorRun(fixture, taskId, {
        pauseSupervision: true,
        createObligations: true,
      })

      const pause = await fixture.request({
        method: 'POST',
        path: `/v1/tasks/${taskId}/actions`,
        body: {
          supervisorRunId: runId,
          actor: supervisor,
          action: { type: 'pause_supervision', reason: 'human handoff' },
          idempotencyKey: 'server-supervisor-actions:pause',
        },
      })
      expect(pause.status).toBe(200)

      const blocked = await fixture.request({
        method: 'POST',
        path: `/v1/tasks/${taskId}/actions`,
        body: {
          supervisorRunId: runId,
          actor: supervisor,
          action: {
            type: 'create_obligation',
            kind: 'missing_evidence',
            summary: 'blocked while paused',
            blocking: false,
          },
          idempotencyKey: 'server-supervisor-actions:paused-block',
        },
      })
      expect(blocked.status).toBe(422)
      await expect(blocked.json()).resolves.toMatchObject({
        error: { code: 'supervisor_paused' },
      })

      const unpause = await fixture.request({
        method: 'POST',
        path: `/v1/tasks/${taskId}/actions`,
        body: {
          supervisorRunId: runId,
          actor: supervisor,
          action: { type: 'unpause_supervision', reason: 'ready' },
          idempotencyKey: 'server-supervisor-actions:unpause',
        },
      })
      expect(unpause.status).toBe(200)

      const accepted = await fixture.request({
        method: 'POST',
        path: `/v1/tasks/${taskId}/actions`,
        body: {
          supervisorRunId: runId,
          actor: supervisor,
          action: {
            type: 'create_obligation',
            kind: 'missing_evidence',
            summary: 'accepted after unpause',
            blocking: false,
          },
          idempotencyKey: 'server-supervisor-actions:after-unpause',
        },
      })
      expect(accepted.status).toBe(200)
    })
  })
})
