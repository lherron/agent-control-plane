import { describe, expect, test } from 'bun:test'

import { listEvents, listPendingWakes } from 'coordination-substrate'

import type { AcpServerDeps } from '../src/index.js'

import { withWiredServer } from './fixtures/wired-server.js'

type LaunchCall = Parameters<NonNullable<AcpServerDeps['launchRoleScopedRun']>>[0]

function createLaunchOverrides(calls: LaunchCall[]): Partial<AcpServerDeps> {
  return {
    runtimeResolver: async () => ({
      agentRoot: '/tmp/agents/curly',
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

describe('POST /v1/coordination/messages', () => {
  test('accepts the minimal high-level message shape and persists a coordination event', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request({
        method: 'POST',
        path: '/v1/coordination/messages',
        body: {
          projectId: fixture.seed.projectId,
          from: { kind: 'agent', agentId: 'clod' },
          to: { kind: 'agent', agentId: 'curly' },
          body: 'hi',
        },
      })

      expect(response.status).toBe(201)

      const payload = await fixture.json<{
        coordinationEventId: string
        messageId: string
      }>(response)
      const events = listEvents(fixture.coordStore, { projectId: fixture.seed.projectId })

      expect(payload.coordinationEventId).toBeTruthy()
      expect(payload.messageId).toBeTruthy()
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        eventId: payload.coordinationEventId,
        kind: 'message.posted',
        actor: { kind: 'system', id: 'acp-local' },
        participants: [{ kind: 'agent', agentId: 'curly' }],
        content: { kind: 'text', body: 'hi' },
      })
    })
  })

  test('creates a wake when options.wake is true for a sessionRef recipient', async () => {
    await withWiredServer(async (fixture) => {
      const sessionRef = {
        scopeRef: `agent:curly:project:${fixture.seed.projectId}:task:T-71001:role:reviewer`,
        laneRef: 'main',
      } as const

      const response = await fixture.request({
        method: 'POST',
        path: '/v1/coordination/messages',
        body: {
          projectId: fixture.seed.projectId,
          from: { kind: 'human', displayName: 'Operator' },
          to: { kind: 'sessionRef', sessionRef },
          body: 'please review the latest patch',
          options: { wake: true },
        },
      })

      expect(response.status).toBe(201)

      const payload = await fixture.json<{
        coordinationEventId: string
        messageId: string
        wakeRequestId: string
      }>(response)
      const wakes = listPendingWakes(fixture.coordStore, {
        projectId: fixture.seed.projectId,
        sessionRef,
      })

      expect(payload.coordinationEventId).toBeTruthy()
      expect(payload.messageId).toBeTruthy()
      expect(payload.wakeRequestId).toBeTruthy()
      expect(wakes).toHaveLength(1)
      expect(wakes[0]?.wakeId).toBe(payload.wakeRequestId)
    })
  })

  test('returns 400 when options.wake targets a non-session recipient', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request({
        method: 'POST',
        path: '/v1/coordination/messages',
        body: {
          projectId: fixture.seed.projectId,
          from: { kind: 'human', displayName: 'Operator' },
          to: { kind: 'agent', agentId: 'curly' },
          body: 'please review the latest patch',
          options: { wake: true },
        },
      })

      expect(response.status).toBe(400)
      expect(await fixture.json<{ error: { code: string; message: string } }>(response)).toEqual({
        error: {
          code: 'malformed_request',
          message: 'wake requires a sessionRef recipient (to.kind must be "sessionRef")',
        },
      })
      expect(listEvents(fixture.coordStore, { projectId: fixture.seed.projectId })).toHaveLength(0)
      expect(listPendingWakes(fixture.coordStore, { projectId: fixture.seed.projectId })).toHaveLength(0)
    })
  })

  test('dispatches through the shared inputs path when options.dispatch is true', async () => {
    const launchCalls: LaunchCall[] = []

    await withWiredServer(async (fixture) => {
      const sessionRef = {
        scopeRef: `agent:curly:project:${fixture.seed.projectId}:task:T-71002:role:implementer`,
        laneRef: 'main',
      } as const

      const response = await fixture.request({
        method: 'POST',
        path: '/v1/coordination/messages',
        body: {
          projectId: fixture.seed.projectId,
          from: { kind: 'system' },
          to: { kind: 'sessionRef', sessionRef },
          body: 'run the shared dispatcher path',
          options: { dispatch: true },
        },
      })

      expect(response.status).toBe(201)

      const payload = await fixture.json<{
        coordinationEventId: string
        messageId: string
        inputAttemptId: string
        runId: string
      }>(response)

      expect(payload.coordinationEventId).toBeTruthy()
      expect(payload.messageId).toBeTruthy()
      expect(payload.inputAttemptId).toMatch(/^ia_/)
      expect(payload.runId).toMatch(/^run_/)
      expect(launchCalls).toHaveLength(1)
      expect(launchCalls[0]).toMatchObject({
        sessionRef,
        acpRunId: payload.runId,
        inputAttemptId: payload.inputAttemptId,
        intent: {
          initialPrompt: 'run the shared dispatcher path',
        },
      })
    }, createLaunchOverrides(launchCalls))
  })

  test('honors coordinationOnly by writing only the coordination event', async () => {
    const launchCalls: LaunchCall[] = []

    await withWiredServer(async (fixture) => {
      const response = await fixture.request({
        method: 'POST',
        path: '/v1/coordination/messages',
        body: {
          projectId: fixture.seed.projectId,
          from: { kind: 'agent', agentId: 'clod' },
          to: { kind: 'agent', agentId: 'curly' },
          body: { kind: 'json', body: { summary: 'heads up' } },
          options: { coordinationOnly: true },
        },
      })

      expect(response.status).toBe(201)

      const payload = await fixture.json<{
        coordinationEventId: string
        messageId: string
        wakeRequestId?: string | undefined
        inputAttemptId?: string | undefined
        runId?: string | undefined
      }>(response)
      const events = listEvents(fixture.coordStore, { projectId: fixture.seed.projectId })

      expect(payload.coordinationEventId).toBeTruthy()
      expect(payload.messageId).toBeTruthy()
      expect(payload.wakeRequestId).toBeUndefined()
      expect(payload.inputAttemptId).toBeUndefined()
      expect(payload.runId).toBeUndefined()
      expect(events).toHaveLength(1)
      expect(
        listPendingWakes(fixture.coordStore, { projectId: fixture.seed.projectId })
      ).toHaveLength(0)
      expect(fixture.runStore.listRuns()).toHaveLength(0)
      expect(launchCalls).toHaveLength(0)
    }, createLaunchOverrides(launchCalls))
  })

  test('accepts human, agent, sessionRef, and system participants', async () => {
    await withWiredServer(async (fixture) => {
      const cases = [
        {
          from: { kind: 'human', humanId: 'human-123', displayName: 'Dana' },
          to: { kind: 'agent', agentId: 'curly' },
        },
        {
          from: { kind: 'agent', agentId: 'clod' },
          to: {
            kind: 'sessionRef',
            sessionRef: {
              scopeRef: `agent:curly:project:${fixture.seed.projectId}:task:T-71003:role:tester`,
              laneRef: 'main',
            },
          },
        },
        {
          from: { kind: 'system' },
          to: { kind: 'human', humanId: 'human-456', displayName: 'Riley' },
        },
      ] as const

      for (const [index, message] of cases.entries()) {
        const response = await fixture.request({
          method: 'POST',
          path: '/v1/coordination/messages',
          body: {
            projectId: fixture.seed.projectId,
            ...message,
            body: `variant ${index + 1}`,
          },
        })

        expect(response.status).toBe(201)
      }

      expect(listEvents(fixture.coordStore, { projectId: fixture.seed.projectId })).toHaveLength(3)
    })
  })

  test('returns 400 malformed_request when sessionRef participants omit sessionRef', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request({
        method: 'POST',
        path: '/v1/coordination/messages',
        body: {
          projectId: fixture.seed.projectId,
          from: { kind: 'sessionRef' },
          to: { kind: 'agent', agentId: 'curly' },
          body: 'broken sender',
        },
      })

      expect(response.status).toBe(400)
      expect(await fixture.json<{ error: { code: string; message: string } }>(response)).toEqual({
        error: {
          code: 'malformed_request',
          message: 'from.sessionRef must be an object',
        },
      })
    })
  })

  test('returns 400 malformed_request for unknown participant kinds', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request({
        method: 'POST',
        path: '/v1/coordination/messages',
        body: {
          projectId: fixture.seed.projectId,
          from: { kind: 'robot', id: 'r2d2' },
          to: { kind: 'agent', agentId: 'curly' },
          body: 'broken sender',
        },
      })

      expect(response.status).toBe(400)
      expect(await fixture.json<{ error: { code: string; message: string } }>(response)).toEqual({
        error: {
          code: 'malformed_request',
          message: 'from.kind must be one of: human, agent, sessionRef, system',
        },
      })
    })
  })
})
