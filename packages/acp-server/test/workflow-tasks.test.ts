import { describe, expect, test } from 'bun:test'

import { withWiredServer } from './fixtures/wired-server.js'

describe('durable workflow task routes', () => {
  // NOTE (W3): the kernel-transition lifecycle tests that previously lived here
  // ("creates, reloads, transitions, and replays …" and "delivers workflow handoff
  // and wake effects …") asserted the OLD ACP-kernel transition + effect-reconciler
  // behavior. handleApplyWorkflowTransition is now a thin wrkf facade
  // (deps.wrkf.transition.apply) and no longer drives kernel snapshots or the ACP
  // effect reconciler. Per CANONICAL_WORKFLOW_REFACTOR.md (obsolete behavior tests
  // should be deleted, not mechanically rewritten), those two tests were removed;
  // transition.apply delegation is now covered by wrkf-mutation-facades.test.ts.
  // The supervisor-run / control-action tests below still exercise live kernel
  // handlers (not in W3 scope) and are retained.

  test('supervisor launch action records participant run and wakes its role session', async () => {
    await withWiredServer(async (fixture) => {
      const create = await fixture.request({
        method: 'POST',
        path: '/v1/tasks',
        body: {
          projectId: fixture.seed.projectId,
          workflow: { id: 'basic', version: 1 },
          goal: 'delegate owner work',
          roleBindings: { owner: { kind: 'agent', id: 'cody' } },
          supervisor: {
            actor: { kind: 'agent', id: 'rex' },
            autonomy: 'managed',
            capabilities: { launchRuns: true },
          },
          idempotencyKey: 'workflow-supervisor:create',
          actor: { agentId: 'rex' },
        },
      })
      const created = await fixture.json<{ task: { taskId: string } }>(create)
      expect(create.status).toBe(201)

      const startRun = await fixture.request({
        method: 'POST',
        path: '/v1/workflow-supervisor-runs',
        body: {
          taskId: created.task.taskId,
          runId: 'supervisor-run-1',
          supervisor: { kind: 'agent', id: 'rex' },
          autonomy: 'managed',
          capabilities: { launchRuns: true },
          idempotencyKey: 'workflow-supervisor:launch-owner:start',
          actor: { agentId: 'rex' },
        },
      })
      expect(startRun.status).toBe(200)

      const action = await fixture.request({
        method: 'POST',
        path: `/v1/tasks/${created.task.taskId}/actions`,
        body: {
          supervisorRunId: 'supervisor-run-1',
          expectedTaskVersion: 0,
          idempotencyKey: 'workflow-supervisor:launch-owner',
          action: {
            type: 'launch_participant_run',
            role: 'owner',
            actor: { kind: 'agent', id: 'cody' },
          },
        },
      })
      expect(action.status).toBe(200)

      const snapshot = fixture.stateStore.workflowRuntime.loadSnapshot()
      expect(snapshot.participantRuns).toHaveLength(1)
      expect(snapshot.participantRuns[0]?.role).toBe('owner')
      expect(snapshot.effects.map((effect) => [effect.kind, effect.state])).toEqual([
        ['wake_role_session', 'delivered'],
      ])
      expect(snapshot.events.map((event) => event.type)).toContain('effect.intent.delivered')

      const wakes = fixture.coordStore.sqlite
        .query<{ session_ref: string; state: string }, []>(
          'SELECT session_ref, state FROM wake_requests'
        )
        .all()
      expect(wakes).toEqual([
        {
          session_ref: `agent:cody:project:${fixture.seed.projectId}:task:${created.task.taskId}:role:owner~main`,
          state: 'queued',
        },
      ])
    })
  })

  test('starts a workflow supervisor run and persists its context link', async () => {
    await withWiredServer(async (fixture) => {
      const start = await fixture.request({
        method: 'POST',
        path: '/v1/workflow-supervisor-runs',
        body: {
          createTask: {
            projectId: fixture.seed.projectId,
            workflow: { id: 'basic', version: 1 },
            goal: 'supervise owner work',
            roleBindings: { owner: { kind: 'agent', id: 'cody' } },
          },
          supervisor: { kind: 'agent', id: 'rex' },
          autonomy: 'managed',
          capabilities: { launchRuns: true },
          idempotencyKey: 'workflow-supervise:create',
          actor: { agentId: 'rex' },
        },
      })
      const started = await fixture.json<{
        task: { taskId: string; version: number }
        supervisorRun: { runId: string; kind: string; contextHash: string }
        context: { contextHash: string; task: { id: string } }
      }>(start)

      expect(start.status).toBe(201)
      expect(started.supervisorRun.kind).toBe('workflow_supervisor')
      expect(started.supervisorRun.contextHash).toBe(started.context.contextHash)
      expect(started.context.task.id).toBe(started.task.taskId)

      const snapshot = fixture.stateStore.workflowRuntime.loadSnapshot()
      expect(snapshot.tasks).toHaveLength(1)
      expect(snapshot.supervisorRuns).toHaveLength(1)
      expect(snapshot.supervisorRuns[0]?.runId).toBe(started.supervisorRun.runId)
      expect(snapshot.events.map((event) => event.type)).toEqual([
        'task.created',
        'supervisor_run.started',
      ])
    })
  })
})
