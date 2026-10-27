import { describe, expect, test } from 'bun:test'

import type { AcpServerDeps } from '../src/index.js'

import { withWiredServer } from './fixtures/wired-server.js'

type LaunchCall = Parameters<NonNullable<AcpServerDeps['launchRoleScopedRun']>>[0]

function readActor(record: Record<string, unknown>): unknown {
  return record['actor']
}

const ACTOR_ROWS = [
  {
    name: 'header beats body',
    headers: { 'x-acp-actor': 'agent:curly' },
    bodyActor: { kind: 'human', id: 'body-operator' },
    expected: { kind: 'agent', id: 'curly' },
  },
  {
    name: 'body without header',
    headers: undefined,
    bodyActor: { kind: 'human', id: 'body-operator' },
    expected: { kind: 'human', id: 'body-operator' },
  },
  {
    name: 'neither falls back to the default system actor',
    headers: undefined,
    bodyActor: undefined,
    expected: { kind: 'system', id: 'acp-local' },
  },
] as const

function createLaunchOverrides(calls: LaunchCall[]): Partial<AcpServerDeps> {
  return {
    runtimeResolver: async () => ({
      agentRoot: '/tmp/agents/curly',
      projectRoot: '/tmp/project',
      cwd: '/tmp/project',
      runMode: 'task',
      bundle: { kind: 'compose', compose: [] },
      harness: { provider: 'openai', interactive: true },
    }),
    launchRoleScopedRun: async (input) => {
      calls.push(input)
      await input.onEvent?.({
        type: 'message_end',
        messageId: 'assistant-visible',
        message: { role: 'assistant', content: 'Visible response' },
      })

      return {
        runId: input.acpRunId ?? 'launch-run-fallback',
        sessionId: 'session-launch-001',
      }
    },
  }
}

describe('actor-stamp: POST /v1/inputs', () => {
  test('POST /v1/inputs stamps the resolved actor (header > body > default) on the attempt, run and delivery request', async () => {
    for (const [index, row] of ACTOR_ROWS.entries()) {
      const launchCalls: LaunchCall[] = []

      await withWiredServer(async (fixture) => {
        fixture.interfaceStore.bindings.create({
          bindingId: 'ifb_123',
          gatewayId: 'discord_prod',
          conversationRef: 'channel:123',
          scopeRef: `agent:curly:project:${fixture.seed.projectId}`,
          laneRef: 'main',
          projectId: fixture.seed.projectId,
          status: 'active',
          createdAt: '2026-04-23T12:05:00.000Z',
          updatedAt: '2026-04-23T12:05:00.000Z',
        })

        const messageRef = `discord:message:${123 + index}`
        const response = await fixture.request({
          method: 'POST',
          path: '/v1/inputs',
          headers: row.headers,
          body: {
            ...(row.bodyActor !== undefined ? { actor: row.bodyActor } : {}),
            sessionRef: {
              scopeRef: `agent:curly:project:${fixture.seed.projectId}`,
              laneRef: 'main',
            },
            content: `Create a delivery request (${row.name}).`,
            meta: {
              interfaceSource: {
                gatewayId: 'discord_prod',
                bindingId: 'ifb_123',
                conversationRef: 'channel:123',
                messageRef,
                replyToMessageRef: messageRef,
              },
            },
          },
        })

        expect(response.status, row.name).toBe(201)
        const payload = await fixture.json<{
          inputAttempt: Record<string, unknown>
          run: { runId: string }
        }>(response)
        expect(readActor(payload.inputAttempt), row.name).toEqual(row.expected)

        const runResponse = await fixture.request({
          method: 'GET',
          path: `/v1/runs/${payload.run.runId}`,
        })
        expect(runResponse.status, row.name).toBe(200)
        const runPayload = await fixture.json<{ run: Record<string, unknown> }>(runResponse)
        expect(readActor(runPayload.run), row.name).toEqual(row.expected)

        const [delivery] = fixture.interfaceStore.deliveries.listQueuedForGateway('discord_prod')
        expect(readActor(delivery as unknown as Record<string, unknown>), row.name).toEqual(
          row.expected
        )
      }, createLaunchOverrides(launchCalls))
    }
  })
})
