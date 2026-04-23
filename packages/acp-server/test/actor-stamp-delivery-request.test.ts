import { describe, expect, test } from 'bun:test'

import type { AcpServerDeps } from '../src/index.js'

import { withWiredServer } from './fixtures/wired-server.js'

type LaunchCall = Parameters<NonNullable<AcpServerDeps['launchRoleScopedRun']>>[0]

function readActor(record: Record<string, unknown>): unknown {
  return record['actor']
}

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

describe('actor-stamp: delivery requests', () => {
  test('prefers X-ACP-Actor over body actor when creating a delivery request', async () => {
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

      const response = await fixture.request({
        method: 'POST',
        path: '/v1/inputs',
        headers: { 'x-acp-actor': 'agent:curly' },
        body: {
          actor: { kind: 'human', id: 'body-operator' },
          sessionRef: {
            scopeRef: `agent:curly:project:${fixture.seed.projectId}`,
            laneRef: 'main',
          },
          content: 'Create a delivery request.',
          meta: {
            interfaceSource: {
              gatewayId: 'discord_prod',
              bindingId: 'ifb_123',
              conversationRef: 'channel:123',
              messageRef: 'discord:message:123',
              replyToMessageRef: 'discord:message:123',
            },
          },
        },
      })

      expect(response.status).toBe(201)
      const [delivery] = fixture.interfaceStore.deliveries.listQueuedForGateway('discord_prod')
      expect(readActor(delivery as unknown as Record<string, unknown>)).toEqual({
        kind: 'agent',
        id: 'curly',
      })
    }, createLaunchOverrides(launchCalls))
  })

  test('falls back to the body actor when creating a delivery request', async () => {
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

      const response = await fixture.request({
        method: 'POST',
        path: '/v1/inputs',
        body: {
          actor: { kind: 'human', id: 'body-operator' },
          sessionRef: {
            scopeRef: `agent:curly:project:${fixture.seed.projectId}`,
            laneRef: 'main',
          },
          content: 'Create a delivery request from body actor.',
          meta: {
            interfaceSource: {
              gatewayId: 'discord_prod',
              bindingId: 'ifb_123',
              conversationRef: 'channel:123',
              messageRef: 'discord:message:124',
              replyToMessageRef: 'discord:message:124',
            },
          },
        },
      })

      expect(response.status).toBe(201)
      const [delivery] = fixture.interfaceStore.deliveries.listQueuedForGateway('discord_prod')
      expect(readActor(delivery as unknown as Record<string, unknown>)).toEqual({
        kind: 'human',
        id: 'body-operator',
      })
    }, createLaunchOverrides(launchCalls))
  })

  test('falls back to the default system actor when creating a delivery request without an actor', async () => {
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

      const response = await fixture.request({
        method: 'POST',
        path: '/v1/inputs',
        body: {
          sessionRef: {
            scopeRef: `agent:curly:project:${fixture.seed.projectId}`,
            laneRef: 'main',
          },
          content: 'Create a delivery request from the env default actor.',
          meta: {
            interfaceSource: {
              gatewayId: 'discord_prod',
              bindingId: 'ifb_123',
              conversationRef: 'channel:123',
              messageRef: 'discord:message:125',
              replyToMessageRef: 'discord:message:125',
            },
          },
        },
      })

      expect(response.status).toBe(201)
      const [delivery] = fixture.interfaceStore.deliveries.listQueuedForGateway('discord_prod')
      expect(readActor(delivery as unknown as Record<string, unknown>)).toEqual({
        kind: 'system',
        id: 'acp-local',
      })
    }, createLaunchOverrides(launchCalls))
  })
})
