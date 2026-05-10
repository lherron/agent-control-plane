import { describe, expect, test } from 'bun:test'

import { withWiredServer } from './fixtures/wired-server.js'

describe('durable workflow task routes', () => {
  test('creates, reloads, transitions, and replays a workflow task through state store', async () => {
    await withWiredServer(async (fixture) => {
      const create = await fixture.request({
        method: 'POST',
        path: '/v1/tasks',
        body: {
          projectId: fixture.seed.projectId,
          workflow: { id: 'basic', version: 1 },
          goal: 'prove durable workflow route',
          roleBindings: { owner: { kind: 'agent', id: 'cody' } },
          idempotencyKey: 'workflow-test:create',
          actor: { agentId: 'cody' },
        },
      })
      const created = await fixture.json<{ task: { taskId: string; workflow: { hash: string } } }>(
        create
      )

      expect(create.status).toBe(201)
      expect(created.task.workflow.hash).toMatch(/^sha256:/)

      const get = await fixture.request({ method: 'GET', path: `/v1/tasks/${created.task.taskId}` })
      const loaded = await fixture.json<{ task: { state: { status: string; phase: string } } }>(get)
      expect(loaded.task.state).toEqual({ status: 'open', phase: 'todo' })

      const start = await fixture.request({
        method: 'POST',
        path: `/v1/tasks/${created.task.taskId}/transitions`,
        body: {
          transitionId: 'start',
          role: 'owner',
          expectedTaskVersion: 0,
          idempotencyKey: 'workflow-test:start',
          actor: { agentId: 'cody' },
        },
      })
      const started = await fixture.json<{
        task: { state: { status: string; phase: string }; version: number }
      }>(start)
      expect(start.status).toBe(200)
      expect(started.task.state).toEqual({ status: 'active', phase: 'doing' })
      expect(started.task.version).toBe(1)

      const replay = await fixture.request({
        method: 'POST',
        path: `/v1/tasks/${created.task.taskId}/transitions`,
        body: {
          transitionId: 'start',
          role: 'owner',
          expectedTaskVersion: 0,
          idempotencyKey: 'workflow-test:start',
          actor: { agentId: 'cody' },
        },
      })
      const replayed = await fixture.json<{ task: { version: number } }>(replay)
      expect(replay.status).toBe(200)
      expect(replayed.task.version).toBe(1)

      const reloadedSnapshot = fixture.stateStore.workflowRuntime.loadSnapshot()
      expect(reloadedSnapshot.tasks).toHaveLength(1)
      expect(reloadedSnapshot.events.map((event) => event.type)).toEqual([
        'task.created',
        'transition.applied',
      ])
      expect(reloadedSnapshot.idempotency.map((entry) => entry.key).sort()).toEqual([
        'workflow-test:create',
        'workflow-test:start',
      ])
    })
  })

  test('delivers workflow handoff and wake effects into coordination substrate', async () => {
    await withWiredServer(async (fixture) => {
      const create = await fixture.request({
        method: 'POST',
        path: '/v1/tasks',
        body: {
          projectId: fixture.seed.projectId,
          workflow: { id: 'code_defect_fastlane', version: 1 },
          goal: 'repair a regression',
          risk: 'medium',
          roleBindings: {
            implementer: { kind: 'agent', id: 'cody' },
            tester: { kind: 'agent', id: 'clod' },
          },
          idempotencyKey: 'workflow-effects:create',
          actor: { agentId: 'cody' },
        },
      })
      const created = await fixture.json<{ task: { taskId: string } }>(create)
      expect(create.status).toBe(201)

      const transition = await fixture.request({
        method: 'POST',
        path: `/v1/tasks/${created.task.taskId}/transitions`,
        body: {
          transitionId: 'red_to_green',
          role: 'implementer',
          expectedTaskVersion: 0,
          idempotencyKey: 'workflow-effects:red-green',
          actor: { agentId: 'cody' },
          inlineEvidence: [{ kind: 'tdd_green_bundle', ref: 'artifact://green' }],
        },
      })
      expect(transition.status).toBe(200)

      const snapshot = fixture.stateStore.workflowRuntime.loadSnapshot()
      expect(snapshot.effects.map((effect) => [effect.kind, effect.state])).toEqual([
        ['declare_handoff', 'delivered'],
        ['wake_role_session', 'delivered'],
      ])

      const coordinationEvents = fixture.coordStore.sqlite
        .query<{ kind: string; idempotency_key: string | null }, []>(
          `SELECT kind, idempotency_key
             FROM coordination_events
         ORDER BY seq ASC`
        )
        .all()
      expect(coordinationEvents.map((event) => event.kind)).toEqual([
        'handoff.declared',
        'attention.requested',
      ])

      const handoffs = fixture.coordStore.sqlite
        .query<{ task_id: string; kind: string; state: string }, []>(
          'SELECT task_id, kind, state FROM handoffs'
        )
        .all()
      expect(handoffs).toEqual([{ task_id: created.task.taskId, kind: 'review', state: 'open' }])

      const wakes = fixture.coordStore.sqlite
        .query<{ session_ref: string; state: string }, []>(
          'SELECT session_ref, state FROM wake_requests'
        )
        .all()
      expect(wakes).toEqual([
        {
          session_ref: `agent:clod:project:${fixture.seed.projectId}:task:${created.task.taskId}:role:tester~main`,
          state: 'queued',
        },
      ])
    })
  })

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

      const get = await fixture.request({
        method: 'GET',
        path: `/v1/tasks/${started.task.taskId}`,
      })
      const loaded = await fixture.json<{ supervisorRuns: unknown[] }>(get)
      expect(loaded.supervisorRuns).toHaveLength(1)
    })
  })
})
