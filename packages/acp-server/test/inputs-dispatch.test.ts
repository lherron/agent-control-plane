import { describe, expect, test } from 'bun:test'

import type { AcpServerDeps } from '../src/index.js'

import { withWiredServer } from './fixtures/wired-server.js'

type LaunchCall = Parameters<NonNullable<AcpServerDeps['launchRoleScopedRun']>>[0]

function createLaunchOverrides(calls: LaunchCall[]): Partial<AcpServerDeps> {
  return {
    runtimeResolver: async () => ({
      agentRoot: '/tmp/agents/larry',
      projectRoot: '/tmp/project',
      cwd: '/tmp/project',
      runMode: 'task',
      bundle: { kind: 'agent-default' },
      harness: { provider: 'openai', interactive: true },
    }),
    launchRoleScopedRun: async (input) => {
      calls.push(input)
      return {
        runId: input.acpRunId ?? 'run-launch-fallback',
        sessionId: 'session-launch-001',
      }
    },
  }
}

describe('POST /v1/inputs dispatch', () => {
  test('dispatches via launchRoleScopedRun and returns both inputAttempt and run', async () => {
    const launchCalls: LaunchCall[] = []

    await withWiredServer(async (fixture) => {
      const sessionRef = {
        scopeRef: `agent:larry:project:${fixture.seed.projectId}:task:T-61001:role:implementer`,
        laneRef: 'main',
      }

      const response = await fixture.request({
        method: 'POST',
        path: '/v1/inputs',
        body: {
          idempotencyKey: 'inputs-dispatch-1',
          sessionRef,
          content: 'run the repro through canonical ingress',
          actor: { agentId: 'tracy' },
          meta: { source: 'cli' },
        },
      })
      const payload = await fixture.json<{
        inputAttempt: { inputAttemptId: string; taskId?: string | undefined }
        run: { runId: string; scopeRef: string; laneRef: string }
      }>(response)

      expect(response.status).toBe(201)
      expect(payload.inputAttempt.taskId).toBe('T-61001')
      expect(payload.run.runId).toBeTruthy()
      expect(payload.run.scopeRef).toBe(sessionRef.scopeRef)
      expect(payload.run.laneRef).toBe(sessionRef.laneRef)
      expect(launchCalls).toHaveLength(1)
      expect(launchCalls[0]).toEqual(
        expect.objectContaining({
          sessionRef,
          acpRunId: payload.run.runId,
          inputAttemptId: payload.inputAttempt.inputAttemptId,
          runStore: fixture.runStore,
        })
      )
    }, createLaunchOverrides(launchCalls))
  })

  test('replays the original run on idempotent retry without redispatching', async () => {
    const launchCalls: LaunchCall[] = []

    await withWiredServer(async (fixture) => {
      const body = {
        idempotencyKey: 'inputs-dispatch-2',
        sessionRef: {
          scopeRef: `agent:larry:project:${fixture.seed.projectId}:task:T-61002:role:implementer`,
          laneRef: 'main',
        },
        content: 'dedupe dispatch across retries',
        actor: { agentId: 'tracy' },
      }

      const first = await fixture.request({ method: 'POST', path: '/v1/inputs', body })
      const second = await fixture.request({ method: 'POST', path: '/v1/inputs', body })
      const firstPayload = await fixture.json<{
        inputAttempt: { inputAttemptId: string }
        run: { runId: string }
      }>(first)
      const secondPayload = await fixture.json<{
        inputAttempt: { inputAttemptId: string }
        run: { runId: string }
      }>(second)

      expect(first.status).toBe(201)
      expect(second.status).toBe(200)
      expect(firstPayload.inputAttempt.inputAttemptId).toBe(
        secondPayload.inputAttempt.inputAttemptId
      )
      expect(firstPayload.run.runId).toBe(secondPayload.run.runId)
      expect(launchCalls).toHaveLength(1)
    }, createLaunchOverrides(launchCalls))
  })

  test('dispatch:false returns a pending run without invoking the launcher', async () => {
    const launchCalls: LaunchCall[] = []

    await withWiredServer(async (fixture) => {
      const response = await fixture.request({
        method: 'POST',
        path: '/v1/inputs',
        body: {
          idempotencyKey: 'inputs-dispatch-3',
          sessionRef: {
            scopeRef: `agent:larry:project:${fixture.seed.projectId}:task:T-61003:role:implementer`,
            laneRef: 'main',
          },
          content: 'record only, do not dispatch',
          actor: { agentId: 'tracy' },
          dispatch: false,
        },
      })
      const payload = await fixture.json<{
        inputAttempt: { inputAttemptId: string }
        run: { runId: string; status: string }
      }>(response)

      expect(response.status).toBe(201)
      expect(launchCalls).toHaveLength(0)
      expect(payload.inputAttempt.inputAttemptId).toBeTruthy()
      expect(payload.run.status).toBe('pending')
      expect(fixture.runStore.getRun(payload.run.runId)?.status).toBe('pending')
    }, createLaunchOverrides(launchCalls))
  })
})
