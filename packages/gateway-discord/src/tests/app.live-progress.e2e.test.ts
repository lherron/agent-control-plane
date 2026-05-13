import { describe, expect, test } from 'bun:test'

import { GatewayDiscordApp } from '../app.js'
import {
  FakeChannel,
  FakeClient,
  type FakeWebhook,
  createLiveProgressHarness,
  toolEnd,
  toolStart,
  waitFor,
} from './live-progress-test-helpers.test.js'

describe('GatewayDiscordApp live tool progress e2e', () => {
  test('edits the placeholder with compact hermes-style tool progress', async () => {
    const harness = createLiveProgressHarness()
    await harness.app.refreshBindings()
    await harness.app.handleMessageCreate(harness.inboundMessage())

    const webhook = harness.webhook()
    expect(webhook.sent).toHaveLength(1)
    expect(webhook.sent[0]?.content).toContain('⏳ **Processing:**')

    harness.emit(toolStart(1, 'tool_1', 'Bash', { command: 'bun test' }))
    harness.emit(toolEnd(2, 'tool_1', 'Bash'))
    harness.emit(toolStart(3, 'tool_2', 'Bash', { command: 'bun test' }))
    harness.emit(toolEnd(4, 'tool_2', 'Bash'))
    harness.emit(
      toolStart(5, 'tool_3', 'Read', { file_path: 'packages/gateway-discord/src/app.ts' })
    )
    harness.emit(toolEnd(6, 'tool_3', 'Read'))

    await waitFor(() => webhook.edits.length > 0)

    expect(harness.eventRequests).toHaveLength(1)
    expect(harness.eventRequests[0]?.searchParams.get('follow')).toBe('true')
    expect(harness.eventRequests[0]?.searchParams.get('fromSeq')).toBe('1')
    expect(harness.eventRequests[0]?.searchParams.get('sessionRef')).toBe(
      'agent:smokey:project:agent-spaces/lane:main'
    )
    expect(harness.eventRequests[0]?.searchParams.has('runId')).toBe(false)

    const content = webhook.edits.at(-1)?.payload.content ?? ''
    expect(content).toContain('💻 shell: bun test')
    expect(content).toContain('(×2)')
    expect(content).toContain('📖 Read: packages/gateway-discord/src/app.ts')
    expect(content).not.toContain('✅ **Bash**')
    expect(content).not.toContain('```')

    const toolLineIcons = ['💻', '📖', '✍️', '🔧', '🔎', '📁', '🤖', '📄', '🔍', '📋', '📓', '⚙️']
    const toolLines = content
      .split('\n')
      .filter((line) => toolLineIcons.some((icon) => line.includes(icon)))
    expect(toolLines.length).toBeLessThanOrEqual(12)
    for (const line of toolLines) {
      expect(line.length).toBeLessThanOrEqual(80)
    }
  })

  test('keeps live progress edits isolated per canonical sessionRef across same-project bindings', async () => {
    const channelA = new FakeChannel('chan_scope_a')
    const channelB = new FakeChannel('chan_scope_b')
    const client = new FakeClient()
    client.addChannel(channelA)
    client.addChannel(channelB)

    const sessionA = 'agent:cody:project:agent-spaces:task:scope-A/lane:main'
    const sessionB = 'agent:cody:project:agent-spaces:task:scope-B/lane:main'
    const streamControllers = new Map<string, ReadableStreamDefaultController<Uint8Array>>()
    const pendingBySession = new Map<string, string[]>()
    const eventRequests: URL[] = []
    const encoder = new TextEncoder()
    let ingressCount = 0

    const bindingFor = (suffix: 'a' | 'b', channelId: string, taskId: string) => ({
      bindingId: `ifb_scope_${suffix}`,
      gatewayId: 'discord_prod',
      conversationRef: `channel:${channelId}`,
      scopeRef: `agent:cody:project:agent-spaces:task:${taskId}`,
      laneRef: 'main',
      sessionRef: {
        scopeRef: `agent:cody:project:agent-spaces:task:${taskId}`,
        laneRef: 'main',
      },
      projectId: 'agent-spaces',
      status: 'active',
      createdAt: '2026-05-06T19:00:00.000Z',
      updatedAt: '2026-05-06T19:00:00.000Z',
    })

    const emitToSession = (
      sessionRef: string,
      input: {
        seq: number
        runId: string
        scopeRef: string
        toolUseId: string
        toolName: string
        toolInput: Record<string, unknown>
      }
    ) => {
      const line = `${JSON.stringify({
        hrcSeq: input.seq,
        streamSeq: input.seq,
        ts: new Date(Date.now() + input.seq * 1000).toISOString(),
        hostSessionId: `hsid_${sessionRef}`,
        scopeRef: input.scopeRef,
        laneRef: 'main',
        generation: 7,
        runtimeId: `rt_${sessionRef}`,
        runId: input.runId,
        category: 'turn',
        eventKind: 'tool_execution_start',
        replayed: false,
        payload: {
          type: 'tool_execution_start',
          toolUseId: input.toolUseId,
          toolName: input.toolName,
          input: input.toolInput,
        },
      })}\n`
      const controller = streamControllers.get(sessionRef)
      if (controller) {
        controller.enqueue(encoder.encode(line))
        return
      }
      const pending = pendingBySession.get(sessionRef) ?? []
      pending.push(line)
      pendingBySession.set(sessionRef, pending)
    }

    const fetchImpl = async (
      input: string | URL | Request,
      init?: RequestInit
    ): Promise<Response> => {
      const request = input instanceof Request ? input : new Request(String(input), init)
      const url = new URL(request.url)

      if (url.pathname === '/v1/interface/bindings') {
        return Response.json({
          bindings: [
            bindingFor('a', 'chan_scope_a', 'scope-A'),
            bindingFor('b', 'chan_scope_b', 'scope-B'),
          ],
        })
      }

      if (url.pathname === '/v1/interface/messages') {
        ingressCount += 1
        const runId =
          ingressCount === 1
            ? 'run_scope_a'
            : ingressCount === 2
              ? 'run_scope_b_distinct'
              : 'run_scope_b_shared'
        return Response.json(
          {
            inputAttemptId: `ia_${ingressCount}`,
            runId,
            hostSessionId: `hsid_${ingressCount}`,
            generation: 7,
          },
          { status: 201 }
        )
      }

      if (url.pathname.startsWith('/v1/runs/')) {
        const runId = decodeURIComponent(url.pathname.slice('/v1/runs/'.length))
        const hrcRunId =
          runId === 'run_scope_b_distinct' ? 'hrc_scope_b_distinct' : 'hrc_shared_scope_run'
        return Response.json({
          run: {
            runId,
            status: 'running',
            hrcRunId,
            hostSessionId: `hsid_${runId}`,
            runtimeId: `rt_${runId}`,
            generation: 7,
          },
        })
      }

      if (url.pathname === '/v1/session-refs/events') {
        const sessionRef = url.searchParams.get('sessionRef') ?? ''
        eventRequests.push(url)
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            streamControllers.set(sessionRef, controller)
            const pending = pendingBySession.get(sessionRef) ?? []
            pendingBySession.delete(sessionRef)
            for (const line of pending) {
              controller.enqueue(encoder.encode(line))
            }
          },
          cancel() {
            streamControllers.delete(sessionRef)
          },
        })
        return new Response(stream, {
          status: 200,
          headers: { 'content-type': 'application/x-ndjson' },
        })
      }

      if (url.pathname === '/v1/gateway/discord_prod/deliveries/stream') {
        return Response.json({ deliveries: [], nextCursor: null })
      }

      return new Response('not found', { status: 404 })
    }

    const app = new GatewayDiscordApp({
      acpBaseUrl: 'http://acp.test',
      gatewayId: 'discord_prod',
      client: client as never,
      fetchImpl,
    })

    const webhookFor = (channel: FakeChannel): FakeWebhook => {
      const webhook = [...channel.webhooks.values()].find((item) => item.name === 'agent-pulpit')
      expect(webhook).toBeDefined()
      return webhook as FakeWebhook
    }
    const latestEditFor = (webhook: FakeWebhook, messageId: string): string =>
      webhook.edits.filter((edit) => edit.messageId === messageId).at(-1)?.payload.content ?? ''

    try {
      await app.refreshBindings()
      await waitFor(() => eventRequests.length === 2)

      await app.handleMessageCreate({
        guildId: 'guild_1',
        author: { id: 'user_1', bot: false },
        content: 'scope A prompt',
        attachments: { size: 0 },
        channelId: 'chan_scope_a',
        id: 'msg_scope_a',
        channel: { isThread: () => false },
        reply: async () => undefined,
      } as never)
      await app.handleMessageCreate({
        guildId: 'guild_1',
        author: { id: 'user_1', bot: false },
        content: 'scope B distinct prompt',
        attachments: { size: 0 },
        channelId: 'chan_scope_b',
        id: 'msg_scope_b_distinct',
        channel: { isThread: () => false },
        reply: async () => undefined,
      } as never)
      await app.handleMessageCreate({
        guildId: 'guild_1',
        author: { id: 'user_1', bot: false },
        content: 'scope B shared prompt',
        attachments: { size: 0 },
        channelId: 'chan_scope_b',
        id: 'msg_scope_b_shared',
        channel: { isThread: () => false },
        reply: async () => undefined,
      } as never)

      const webhookA = webhookFor(channelA)
      const webhookB = webhookFor(channelB)
      const messageA = webhookA.sent[0]?.message.id ?? ''
      const messageBDistinct = webhookB.sent[0]?.message.id ?? ''
      const messageBShared = webhookB.sent[1]?.message.id ?? ''

      emitToSession(sessionA, {
        seq: 1,
        runId: 'hrc_shared_scope_run',
        scopeRef: 'agent:cody:project:agent-spaces:task:scope-A',
        toolUseId: 'scope-a-tool',
        toolName: 'Bash',
        toolInput: { command: 'scope A only' },
      })
      emitToSession(sessionB, {
        seq: 1,
        runId: 'hrc_scope_b_distinct',
        scopeRef: 'agent:cody:project:agent-spaces:task:scope-B',
        toolUseId: 'scope-b-distinct-tool',
        toolName: 'Read',
        toolInput: { file_path: 'scope-b-distinct.md' },
      })
      emitToSession(sessionB, {
        seq: 2,
        runId: 'hrc_shared_scope_run',
        scopeRef: 'agent:cody:project:agent-spaces:task:scope-B',
        toolUseId: 'scope-b-shared-tool',
        toolName: 'Write',
        toolInput: { file_path: 'scope-b-shared.md' },
      })

      await waitFor(
        () =>
          latestEditFor(webhookA, messageA).length > 0 &&
          latestEditFor(webhookB, messageBDistinct).length > 0 &&
          latestEditFor(webhookB, messageBShared).length > 0
      )

      const scopeAContent = latestEditFor(webhookA, messageA)
      const scopeBDistinctContent = latestEditFor(webhookB, messageBDistinct)
      const scopeBSharedContent = latestEditFor(webhookB, messageBShared)

      expect(scopeAContent).toContain('scope A only')
      expect(scopeAContent).not.toContain('scope-b-distinct.md')
      expect(scopeAContent).not.toContain('scope-b-shared.md')
      expect(scopeBDistinctContent).toContain('scope-b-distinct.md')
      expect(scopeBDistinctContent).not.toContain('scope A only')
      expect(scopeBDistinctContent).not.toContain('scope-b-shared.md')
      expect(scopeBSharedContent).toContain('scope-b-shared.md')
      expect(scopeBSharedContent).not.toContain('scope A only')
      expect(scopeBSharedContent).not.toContain('scope-b-distinct.md')
    } finally {
      await app.stop()
    }
  })
})
