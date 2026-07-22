import { describe, expect, test } from 'bun:test'

import { createInterfaceRunDispatcher } from '../src/integration/interface-run-dispatcher.js'
import { withWiredServer } from './fixtures/wired-server.js'

describe('POST /v1/inputs and GET /v1/runs/:runId', () => {
  test('creates an input attempt and a run', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request({
        method: 'POST',
        path: '/v1/inputs',
        body: {
          idempotencyKey: 'input-1',
          sessionRef: {
            scopeRef: 'agent:larry:project:demo:task:T-60001:role:implementer',
            laneRef: 'main',
          },
          content: 'run the repro',
          actor: { agentId: 'tracy' },
          meta: { source: 'cli' },
        },
      })
      const payload = await fixture.json<{ inputAttempt: { taskId?: string } }>(response)

      expect(response.status).toBe(201)
      expect(payload.inputAttempt.taskId).toBe('T-60001')
      expect(fixture.runStore.listRuns()).toHaveLength(1)
    })
  })

  test('deduplicates identical idempotency keys', async () => {
    await withWiredServer(async (fixture) => {
      const body = {
        idempotencyKey: 'input-2',
        sessionRef: {
          scopeRef: 'agent:larry:project:demo:task:T-60002:role:implementer',
          laneRef: 'main',
        },
        content: 'repeatable input',
        actor: { agentId: 'tracy' },
      }

      const first = await fixture.request({ method: 'POST', path: '/v1/inputs', body })
      const second = await fixture.request({ method: 'POST', path: '/v1/inputs', body })
      const firstPayload = await fixture.json<{ inputAttempt: { inputAttemptId: string } }>(first)
      const secondPayload = await fixture.json<{ inputAttempt: { inputAttemptId: string } }>(second)

      expect(firstPayload.inputAttempt.inputAttemptId).toBe(
        secondPayload.inputAttempt.inputAttemptId
      )
      expect(fixture.runStore.listRuns()).toHaveLength(1)
    })
  })

  test('returns 409 for different bodies using the same idempotency key', async () => {
    await withWiredServer(async (fixture) => {
      await fixture.request({
        method: 'POST',
        path: '/v1/inputs',
        body: {
          idempotencyKey: 'input-3',
          sessionRef: {
            scopeRef: 'agent:larry:project:demo:task:T-60003:role:implementer',
            laneRef: 'main',
          },
          content: 'first body',
          actor: { agentId: 'tracy' },
        },
      })

      const response = await fixture.request({
        method: 'POST',
        path: '/v1/inputs',
        body: {
          idempotencyKey: 'input-3',
          sessionRef: {
            scopeRef: 'agent:larry:project:demo:task:T-60003:role:implementer',
            laneRef: 'main',
          },
          content: 'second body',
          actor: { agentId: 'tracy' },
        },
      })

      expect(response.status).toBe(409)
    })
  })

  test('returns stored runs by runId', async () => {
    await withWiredServer(async (fixture) => {
      await fixture.request({
        method: 'POST',
        path: '/v1/inputs',
        body: {
          sessionRef: {
            scopeRef: 'agent:larry:project:demo:task:T-60004:role:implementer',
            laneRef: 'main',
          },
          content: 'inspect run',
          actor: { agentId: 'tracy' },
        },
      })
      const runId = fixture.runStore.listRuns()[0]?.runId

      const response = await fixture.request({
        method: 'GET',
        path: `/v1/runs/${runId}`,
      })
      const payload = await fixture.json<{
        run: { runId: string; status: string; updatedAt: string }
        liveness: { lastActivityAt: string }
      }>(response)

      expect(response.status).toBe(200)
      expect(payload.run.runId).toBe(runId)
      expect(payload.run.status).toBe('pending')
      expect(payload.liveness.lastActivityAt).toBe(payload.run.updatedAt)
    })
  })

  test('projects correlated renderer liveness on the run resource', async () => {
    const lastActivityAt = '2026-07-16T12:30:00.000Z'
    await withWiredServer(
      async (fixture) => {
        await fixture.request({
          method: 'POST',
          path: '/v1/inputs',
          body: {
            sessionRef: {
              scopeRef: 'agent:scribe:project:demo:task:AR-live',
              laneRef: 'main',
            },
            content: 'render this artifact',
            actor: { agentId: 'taskboard' },
          },
        })
        const runId = fixture.runStore.listRuns()[0]?.runId

        const response = await fixture.request({
          method: 'GET',
          path: `/v1/runs/${runId}`,
        })
        const payload = await fixture.json<{ liveness: { lastActivityAt: string } }>(response)

        expect(response.status).toBe(200)
        expect(payload.liveness.lastActivityAt).toBe(lastActivityAt)
      },
      { runLivenessResolver: async () => lastActivityAt }
    )
  })

  test('projects the terminal semantic response for a plain federated-message run', async () => {
    await withWiredServer(async (fixture) => {
      const run = fixture.runStore.createRun({
        sessionRef: {
          scopeRef: 'agent:scribe:project:hrc-runtime:task:T-06805-t4-caller',
          laneRef: 'main',
        },
        status: 'running',
        metadata: {
          meta: {
            hrcSemanticMessage: {
              requestMessageId: 'msg-t4-request',
              rootMessageId: 'msg-t4-request',
              afterSeq: 6805,
              localNodeId: 'svc',
              homeNodeId: 'max3',
            },
          },
        },
      })
      fixture.runStore.updateRun(run.runId, { transport: 'federated-message' })

      const dispatcher = createInterfaceRunDispatcher({
        runStore: fixture.runStore,
        interfaceStore: fixture.interfaceStore,
        hrcDbPath: '/tmp/t06805-unused-hrc.sqlite',
        hrcClient: {
          waitMessage: async () => ({
            matched: true as const,
            record: {
              messageSeq: 6812,
              messageId: 'msg-t4-response',
              createdAt: '2026-07-22T22:22:12.000Z',
              kind: 'dm' as const,
              phase: 'response' as const,
              from: {
                kind: 'session' as const,
                sessionRef: `${run.scopeRef}/lane:main`,
              },
              to: { kind: 'entity' as const, entity: 'human' },
              replyToMessageId: 'msg-t4-request',
              rootMessageId: 'msg-t4-request',
              body: 'T4B_PONG_6805',
              bodyFormat: 'text/plain' as const,
              execution: { state: 'not_applicable' as const },
            },
          }),
        },
        config: { intervalMs: 1, staleTimeoutMs: 60_000 },
      })
      await dispatcher.runOnce()

      const response = await fixture.request({
        method: 'GET',
        path: `/v1/runs/${run.runId}`,
      })
      const payload = await fixture.json<{
        run: {
          status: string
          response?: { messageId: string; body: string; createdAt: string }
        }
      }>(response)

      expect(response.status).toBe(200)
      expect(payload.run).toMatchObject({
        status: 'completed',
        response: {
          messageId: 'msg-t4-response',
          body: 'T4B_PONG_6805',
          createdAt: '2026-07-22T22:22:12.000Z',
        },
      })
    })
  })
})
