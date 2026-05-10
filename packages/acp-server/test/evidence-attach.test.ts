import { describe, expect, test } from 'bun:test'

import { withWiredServer } from './fixtures/wired-server.js'

async function createEvidenceTask(
  fixture: Parameters<Parameters<typeof withWiredServer>[0]>[0],
  id = 'default'
) {
  const create = await fixture.request({
    method: 'POST',
    path: '/v1/tasks',
    body: {
      taskId: `evidence-attach-${id}`,
      projectId: fixture.seed.projectId,
      workflow: { id: 'basic', version: 1 },
      goal: 'attach standalone evidence',
      roleBindings: { owner: { kind: 'agent', id: 'cody' } },
      supervisor: {
        actor: { kind: 'agent', id: 'rex' },
        autonomy: 'managed',
        capabilities: { attachEvidence: true, launchRuns: true },
      },
      idempotencyKey: `evidence-attach:create:${id}`,
      actor: { agentId: 'rex' },
    },
  })
  expect(create.status).toBe(201)
  return fixture.json<{ task: { taskId: string; version: number } }>(create)
}

async function attachEvidence(
  fixture: Parameters<Parameters<typeof withWiredServer>[0]>[0],
  taskId: string,
  body: Record<string, unknown>
) {
  return fixture.request({
    method: 'POST',
    path: `/v1/tasks/${taskId}/evidence`,
    body,
  })
}

describe('standalone workflow evidence attach route', () => {
  test('supervisor with attachEvidence capability attaches evidence with supervisor provenance', async () => {
    await withWiredServer(async (fixture) => {
      const { task } = await createEvidenceTask(fixture)

      const response = await attachEvidence(fixture, task.taskId, {
        actor: { kind: 'agent', id: 'rex' },
        supervisorRunId: 'supervisor-run-rex-1',
        evidence: [{ kind: 'completion_note', ref: 'artifact://supervisor', summary: 'done' }],
        expectedTaskVersion: 0,
        idempotencyKey: 'evidence-attach:supervisor',
      })
      const attached = await fixture.json<{ evidence: Array<{ evidenceId: string }> }>(response)

      expect(response.status).toBe(201)
      expect(attached.evidence[0]?.evidenceId).toMatch(/^evd_/)
      expect(fixture.stateStore.workflowRuntime.loadSnapshot().evidence[0]).toMatchObject({
        kind: 'completion_note',
        ref: 'artifact://supervisor',
        actor: { kind: 'agent', id: 'rex' },
        supervisorRunId: 'supervisor-run-rex-1',
      })
    })
  })

  test('role-bound actor attaches evidence with role and run provenance', async () => {
    await withWiredServer(async (fixture) => {
      const { task } = await createEvidenceTask(fixture)

      const response = await attachEvidence(fixture, task.taskId, {
        actor: { kind: 'agent', id: 'cody' },
        role: 'owner',
        runId: 'owner-run-1',
        evidence: [{ kind: 'completion_note', ref: 'artifact://owner', summary: 'done' }],
        expectedTaskVersion: 0,
        idempotencyKey: 'evidence-attach:role-bound',
      })

      expect(response.status).toBe(201)
      expect(fixture.stateStore.workflowRuntime.loadSnapshot().evidence[0]).toMatchObject({
        actor: { kind: 'agent', id: 'cody' },
        role: 'owner',
        runId: 'owner-run-1',
      })
    })
  })

  test('persisted participant run actor attaches evidence with participantRunId provenance', async () => {
    await withWiredServer(async (fixture) => {
      const { task } = await createEvidenceTask(fixture)
      const startRun = await fixture.request({
        method: 'POST',
        path: '/v1/workflow-supervisor-runs',
        body: {
          taskId: task.taskId,
          runId: 'supervisor-run-rex-1',
          supervisor: { kind: 'agent', id: 'rex' },
          autonomy: 'managed',
          capabilities: { launchRuns: true },
          idempotencyKey: 'evidence-attach:launch-participant:start',
          actor: { agentId: 'rex' },
        },
      })
      expect(startRun.status).toBe(200)

      const launch = await fixture.request({
        method: 'POST',
        path: `/v1/tasks/${task.taskId}/actions`,
        body: {
          supervisorRunId: 'supervisor-run-rex-1',
          expectedTaskVersion: 0,
          idempotencyKey: 'evidence-attach:launch-participant',
          action: {
            type: 'launch_participant_run',
            role: 'owner',
            actor: { kind: 'agent', id: 'cody' },
          },
        },
      })
      expect(launch.status).toBe(200)
      const participantRunId =
        fixture.stateStore.workflowRuntime.loadSnapshot().participantRuns[0]?.runId
      expect(participantRunId).toBeDefined()

      const response = await attachEvidence(fixture, task.taskId, {
        actor: { kind: 'agent', id: 'cody' },
        role: 'owner',
        participantRunId,
        evidence: [{ kind: 'completion_note', ref: 'artifact://participant', summary: 'done' }],
        expectedTaskVersion: 0,
        idempotencyKey: 'evidence-attach:participant',
      })

      expect(response.status).toBe(201)
      expect(fixture.stateStore.workflowRuntime.loadSnapshot().evidence[0]).toMatchObject({
        actor: { kind: 'agent', id: 'cody' },
        role: 'owner',
        participantRunId,
      })
    })
  })

  test('rejects participantRunId provenance from another task', async () => {
    await withWiredServer(async (fixture) => {
      const { task } = await createEvidenceTask(fixture, 'primary')
      const { task: otherTask } = await createEvidenceTask(fixture, 'other')
      const startRun = await fixture.request({
        method: 'POST',
        path: '/v1/workflow-supervisor-runs',
        body: {
          taskId: otherTask.taskId,
          runId: 'supervisor-run-rex-other',
          supervisor: { kind: 'agent', id: 'rex' },
          autonomy: 'managed',
          capabilities: { launchRuns: true },
          idempotencyKey: 'evidence-attach:cross-task:start-supervisor',
          actor: { agentId: 'rex' },
        },
      })
      expect(startRun.status).toBe(200)

      const launch = await fixture.request({
        method: 'POST',
        path: `/v1/tasks/${otherTask.taskId}/actions`,
        body: {
          supervisorRunId: 'supervisor-run-rex-other',
          expectedTaskVersion: 0,
          idempotencyKey: 'evidence-attach:cross-task:launch-participant',
          action: {
            type: 'launch_participant_run',
            role: 'owner',
            actor: { kind: 'agent', id: 'cody' },
          },
        },
      })
      expect(launch.status).toBe(200)
      const participantRunId = fixture.stateStore.workflowRuntime
        .loadSnapshot()
        .participantRuns.find((run) => run.taskId === otherTask.taskId)?.runId
      expect(participantRunId).toBeDefined()

      const response = await attachEvidence(fixture, task.taskId, {
        actor: { kind: 'agent', id: 'cody' },
        role: 'owner',
        participantRunId,
        evidence: [{ kind: 'completion_note', ref: 'artifact://cross-task', summary: 'done' }],
        expectedTaskVersion: 0,
        idempotencyKey: 'evidence-attach:cross-task:attach',
      })
      const body = await fixture.json<{ error: { code: string } }>(response)

      expect(response.status).toBe(403)
      expect(body.error.code).toBe('authority_not_granted')
      expect(
        fixture.stateStore.workflowRuntime
          .loadSnapshot()
          .evidence.filter((record) => record.taskId === task.taskId)
      ).toHaveLength(0)
    })
  })

  test('rejects unauthorized actor and invalid evidence kind before persistence', async () => {
    await withWiredServer(async (fixture) => {
      const { task } = await createEvidenceTask(fixture)

      const unauthorized = await attachEvidence(fixture, task.taskId, {
        actor: { kind: 'agent', id: 'mallory' },
        role: 'owner',
        evidence: [{ kind: 'completion_note', ref: 'artifact://bad', summary: 'done' }],
        expectedTaskVersion: 0,
        idempotencyKey: 'evidence-attach:unauthorized',
      })
      const unauthorizedBody = await fixture.json<{ error: { code: string } }>(unauthorized)
      expect(unauthorized.status).toBe(403)
      expect(unauthorizedBody.error.code).toBe('authority_not_granted')

      const invalidKind = await attachEvidence(fixture, task.taskId, {
        actor: { kind: 'agent', id: 'cody' },
        role: 'owner',
        evidence: [{ kind: 'not_in_workflow', ref: 'artifact://bad' }],
        expectedTaskVersion: 0,
        idempotencyKey: 'evidence-attach:invalid-kind',
      })
      const invalidKindBody = await fixture.json<{ error: { code: string } }>(invalidKind)
      expect(invalidKind.status).toBe(422)
      expect(invalidKindBody.error.code).toBe('invalid_evidence')

      expect(fixture.stateStore.workflowRuntime.loadSnapshot().evidence).toHaveLength(0)
    })
  })

  test('replays matching idempotency key payloads and conflicts on different payloads', async () => {
    await withWiredServer(async (fixture) => {
      const { task } = await createEvidenceTask(fixture)
      const payload = {
        actor: { kind: 'agent', id: 'cody' },
        role: 'owner',
        evidence: [{ kind: 'completion_note', ref: 'artifact://same', summary: 'done' }],
        expectedTaskVersion: 0,
        idempotencyKey: 'evidence-attach:idempotent',
      }

      const first = await attachEvidence(fixture, task.taskId, payload)
      const firstBody = await fixture.json<{ evidence: Array<{ evidenceId: string }> }>(first)
      const replay = await attachEvidence(fixture, task.taskId, payload)
      const replayBody = await fixture.json<{ evidence: Array<{ evidenceId: string }> }>(replay)
      const conflict = await attachEvidence(fixture, task.taskId, {
        ...payload,
        evidence: [{ kind: 'completion_note', ref: 'artifact://different', summary: 'done' }],
      })
      const conflictBody = await fixture.json<{ error: { code: string } }>(conflict)

      expect(first.status).toBe(201)
      expect(replay.status).toBe(200)
      expect(replayBody.evidence).toEqual(firstBody.evidence)
      expect(conflict.status).toBe(409)
      expect(conflictBody.error.code).toBe('idempotency_conflict')
      expect(fixture.stateStore.workflowRuntime.loadSnapshot().evidence).toHaveLength(1)
    })
  })
})
