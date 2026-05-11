import { describe, expect, test } from 'bun:test'

import type { WiredServerFixture } from './fixtures/wired-server.js'
import { withWiredServer } from './fixtures/wired-server.js'

const owner = { kind: 'agent', id: 'larry' } as const
const otherActor = { kind: 'agent', id: 'curly' } as const

async function createWorkflowTask(
  fixture: WiredServerFixture,
  roleBindings: Record<string, typeof owner | null> = { owner }
): Promise<string> {
  const response = await fixture.request({
    method: 'POST',
    path: '/v1/tasks',
    body: {
      projectId: fixture.seed.projectId,
      workflow: { id: 'basic', version: 1 },
      goal: 'launch a participant runtime',
      roleBindings,
      idempotencyKey: `participant-route:create:${Object.keys(roleBindings)
        .map((role) => `${role}:${roleBindings[role]?.id ?? 'unbound'}`)
        .join(',')}`,
      actor: { agentId: 'rex' },
    },
  })
  const body = await fixture.json<{ task: { taskId: string } }>(response)
  expect(response.status).toBe(201)
  return body.task.taskId
}

describe('workflow participant run routes', () => {
  test('POST /v1/workflow-participant-runs launches a bound actor and returns context', async () => {
    await withWiredServer(async (fixture) => {
      const taskId = await createWorkflowTask(fixture)

      const response = await fixture.request({
        method: 'POST',
        path: '/v1/workflow-participant-runs',
        body: {
          taskId,
          role: 'owner',
          actor: owner,
          harness: { kind: 'codex' },
          idempotencyKey: 'participant-route:start:owner',
        },
      })
      const body = await fixture.json<{
        participantRun: {
          runId: string
          kind: string
          taskId: string
          role: string
          actor: typeof owner
          status: string
          contextHash: string
          taskVersionAtStart: number
        }
        context: { contextHash: string; task: { id: string; version: number }; run: { id: string } }
      }>(response)

      expect(response.status).toBe(201)
      expect(body.participantRun).toMatchObject({
        kind: 'participant',
        taskId,
        role: 'owner',
        actor: owner,
        status: 'launched',
        taskVersionAtStart: 0,
      })
      expect(body.context).toMatchObject({
        contextHash: body.participantRun.contextHash,
        task: { id: taskId, version: 0 },
        run: { id: body.participantRun.runId },
      })

      const snapshot = fixture.stateStore.workflowRuntime.loadSnapshot()
      expect(snapshot.participantRuns).toEqual([
        expect.objectContaining({
          runId: body.participantRun.runId,
          role: 'owner',
          actor: owner,
          status: 'launched',
        }),
      ])
      expect(snapshot.events.map((event) => event.type)).toEqual([
        'task.created',
        'participant_run.launched',
      ])
    })
  })

  test('launch records ACP to HRC run mapping when HRC identity is supplied', async () => {
    await withWiredServer(async (fixture) => {
      const taskId = await createWorkflowTask(fixture)

      const response = await fixture.request({
        method: 'POST',
        path: '/v1/workflow-participant-runs',
        body: {
          taskId,
          role: 'owner',
          actor: owner,
          hrcRunId: 'hrc-run-route',
          runtimeId: 'runtime-route',
          launchId: 'launch-route',
          hostSessionId: 'host-session-route',
          scopeRef: 'agent:larry:project:agent-spaces',
          laneRef: 'main',
          generation: 2,
          idempotencyKey: 'participant-route:start:mapped',
        },
      })
      expect(response.status).toBe(201)

      const snapshot = fixture.stateStore.workflowRuntime.loadSnapshot()
      expect(snapshot.workflowHrcRunMaps).toEqual([
        expect.objectContaining({
          workflowTaskId: taskId,
          hrcRunId: 'hrc-run-route',
          runtimeId: 'runtime-route',
          source: 'launch',
        }),
      ])
      expect(snapshot.events.at(-1)).toMatchObject({
        type: 'workflow_hrc_run.mapped',
        result: 'recorded',
        payload: expect.objectContaining({ hrcRunId: 'hrc-run-route' }),
      })
    })
  })

  test('launchRuntime dispatches a real runtime and records returned HRC identity', async () => {
    const launchCalls: unknown[] = []
    await withWiredServer(
      async (fixture) => {
        const taskId = await createWorkflowTask(fixture)

        const response = await fixture.request({
          method: 'POST',
          path: '/v1/workflow-participant-runs',
          body: {
            taskId,
            role: 'owner',
            actor: owner,
            scopeRef: `agent:larry:project:${fixture.seed.projectId}:task:${taskId}`,
            laneRef: 'main',
            launchRuntime: true,
            idempotencyKey: 'participant-route:start:real-launch',
          },
        })
        const body = await fixture.json<{
          participantRun: { runId: string }
          launch: {
            runId: string
            sessionId: string
            hostSessionId?: string
            runtimeId?: string
            launchId?: string
            generation?: number
          }
          workflowHrcRunMap: {
            hrcRunId: string
            runtimeId?: string
            launchId?: string
            hostSessionId?: string
          }
        }>(response)

        expect(response.status).toBe(201)
        expect(body.launch).toMatchObject({
          runId: 'hrc-run-real-1',
          sessionId: 'host-session-real-1',
          hostSessionId: 'host-session-real-1',
          runtimeId: 'runtime-real-1',
          launchId: 'launch-real-1',
          generation: 7,
        })
        expect(body.workflowHrcRunMap).toMatchObject({
          hrcRunId: 'hrc-run-real-1',
          runtimeId: 'runtime-real-1',
          launchId: 'launch-real-1',
          hostSessionId: 'host-session-real-1',
        })
        expect(launchCalls).toHaveLength(1)
        expect(launchCalls[0]).toMatchObject({
          sessionRef: {
            scopeRef: `agent:larry:project:${fixture.seed.projectId}:task:${taskId}`,
            laneRef: 'main',
          },
          intent: {
            initialPrompt: expect.stringContaining(`"id": "${taskId}"`),
          },
        })

        const snapshot = fixture.stateStore.workflowRuntime.loadSnapshot()
        expect(snapshot.workflowHrcRunMaps).toEqual([
          expect.objectContaining({
            workflowTaskId: taskId,
            participantRunId: body.participantRun.runId,
            hrcRunId: 'hrc-run-real-1',
            runtimeId: 'runtime-real-1',
            launchId: 'launch-real-1',
            hostSessionId: 'host-session-real-1',
            source: 'launch',
          }),
        ])
      },
      {
        runtimeResolver: async () => ({
          agentRoot: '/tmp/agents/larry',
          projectRoot: '/tmp/project',
          cwd: '/tmp/project',
          runMode: 'task',
          bundle: { kind: 'agent-default' },
          harness: { provider: 'openai', interactive: true },
        }),
        launchRoleScopedRun: async (input) => {
          launchCalls.push(input)
          return {
            runId: 'hrc-run-real-1',
            sessionId: 'host-session-real-1',
            hostSessionId: 'host-session-real-1',
            runtimeId: 'runtime-real-1',
            launchId: 'launch-real-1',
            generation: 7,
          }
        },
      }
    )
  })

  test('rejects unbound and mismatched actors with role_not_bound', async () => {
    await withWiredServer(async (fixture) => {
      const unboundTaskId = await createWorkflowTask(fixture, { owner: null })
      const unbound = await fixture.request({
        method: 'POST',
        path: '/v1/workflow-participant-runs',
        body: {
          taskId: unboundTaskId,
          role: 'owner',
          actor: owner,
          idempotencyKey: 'participant-route:start:unbound',
        },
      })
      expect(unbound.status).toBe(422)
      await expect(unbound.json()).resolves.toMatchObject({
        error: { code: 'role_not_bound' },
      })

      const boundTaskId = await createWorkflowTask(fixture)
      const mismatch = await fixture.request({
        method: 'POST',
        path: '/v1/workflow-participant-runs',
        body: {
          taskId: boundTaskId,
          role: 'owner',
          actor: otherActor,
          idempotencyKey: 'participant-route:start:mismatch',
        },
      })
      expect(mismatch.status).toBe(422)
      await expect(mismatch.json()).resolves.toMatchObject({
        error: { code: 'role_not_bound' },
      })
    })
  })

  test('idempotently replays launch and resumes the existing run with a fresh context', async () => {
    await withWiredServer(async (fixture) => {
      const taskId = await createWorkflowTask(fixture)
      const body = {
        taskId,
        role: 'owner',
        actor: owner,
        idempotencyKey: 'participant-route:start:idempotent',
      }

      const first = await fixture.request({
        method: 'POST',
        path: '/v1/workflow-participant-runs',
        body,
      })
      const firstBody = await fixture.json<{
        participantRun: { runId: string; contextHash: string }
        context: { contextHash: string }
      }>(first)
      const replay = await fixture.request({
        method: 'POST',
        path: '/v1/workflow-participant-runs',
        body,
      })
      const replayBody = await fixture.json<typeof firstBody>(replay)

      expect(replay.status).toBe(200)
      expect(replayBody).toEqual(firstBody)

      const resumed = await fixture.request({
        method: 'POST',
        path: '/v1/workflow-participant-runs',
        body: {
          taskId,
          role: 'owner',
          actor: owner,
          resume: true,
        },
      })
      const resumedBody = await fixture.json<typeof firstBody>(resumed)

      expect(resumed.status).toBe(200)
      expect(resumedBody.participantRun.runId).toBe(firstBody.participantRun.runId)
      expect(resumedBody.context.contextHash).toBe(resumedBody.participantRun.contextHash)
    })
  })

  test('completion and failure endpoints persist lifecycle status and completion events', async () => {
    await withWiredServer(async (fixture) => {
      const taskId = await createWorkflowTask(fixture)
      const started = await fixture.request({
        method: 'POST',
        path: '/v1/workflow-participant-runs',
        body: {
          taskId,
          role: 'owner',
          actor: owner,
          idempotencyKey: 'participant-route:lifecycle:start',
        },
      })
      const startedBody = await fixture.json<{ participantRun: { runId: string } }>(started)
      expect(started.status).toBe(201)

      const complete = await fixture.request({
        method: 'POST',
        path: `/v1/workflow-participant-runs/${startedBody.participantRun.runId}/complete`,
        body: {
          outcome: 'success',
          evidenceRefs: ['artifact://owner-summary'],
          summary: 'owner finished',
          idempotencyKey: 'participant-route:lifecycle:complete',
        },
      })
      expect(complete.status).toBe(200)

      const failure = await fixture.request({
        method: 'POST',
        path: '/v1/workflow-participant-runs',
        body: {
          taskId,
          role: 'owner',
          actor: owner,
          idempotencyKey: 'participant-route:lifecycle:start-failure',
        },
      })
      const failureBody = await fixture.json<{ participantRun: { runId: string } }>(failure)
      const fail = await fixture.request({
        method: 'POST',
        path: `/v1/workflow-participant-runs/${failureBody.participantRun.runId}/fail`,
        body: {
          reason: 'implementation failed',
          classification: 'participant_repeated_failure',
          idempotencyKey: 'participant-route:lifecycle:fail',
        },
      })
      expect(fail.status).toBe(200)

      const snapshot = fixture.stateStore.workflowRuntime.loadSnapshot()
      expect(snapshot.participantRuns.map((run) => [run.runId, run.status])).toEqual([
        [startedBody.participantRun.runId, 'completed'],
        [failureBody.participantRun.runId, 'failed'],
      ])
      expect(snapshot.events.filter((event) => event.type === 'participant_run.completed')).toEqual(
        [
          expect.objectContaining({
            participantRunId: startedBody.participantRun.runId,
            payload: expect.objectContaining({ outcome: 'success' }),
          }),
          expect.objectContaining({
            participantRunId: failureBody.participantRun.runId,
            payload: expect.objectContaining({
              outcome: 'failed',
              classification: 'participant_repeated_failure',
            }),
          }),
        ]
      )
    })
  })
})
