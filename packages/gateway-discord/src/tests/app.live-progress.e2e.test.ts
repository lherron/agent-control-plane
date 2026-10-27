import { describe, expect, test } from 'bun:test'
import { parseScopeRef } from 'agent-scope'

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
  test('keeps editing a live placeholder with multiple assistant messages and AskUserQuestion', async () => {
    const harness = createLiveProgressHarness()
    await harness.app.refreshBindings()
    await harness.app.handleMessageCreate(harness.inboundMessage())

    const webhook = harness.webhook()
    const messageId = webhook.sent[0]?.message.id ?? ''

    harness.emit(assistantTurnMessage(1, 'First assistant update.'))
    harness.emit(toolStart(2, 'tool_read', 'Read', { file_path: '/tmp/example.txt' }))
    harness.emit(toolEnd(3, 'tool_read', 'Read'))
    harness.emit(assistantTurnMessage(4, 'Second assistant update.'))
    harness.emit(
      hrcTurnEvent(5, 'turn.tool_call', {
        type: 'tool_execution_start',
        toolUseId: 'tool_question',
        toolName: 'AskUserQuestion',
        input: {
          questions: [
            {
              header: 'File layer',
              question: 'How do you want the file layer handled?',
              options: [
                {
                  label: 'Summon agent-minder',
                  description: 'Have agent-minder author the files.',
                },
                {
                  label: 'Stop at plumbing',
                  description: 'Leave the room built and bound.',
                },
              ],
              multiSelect: false,
            },
          ],
        },
      })
    )

    await waitFor(() => {
      const content =
        webhook.edits.filter((edit) => edit.messageId === messageId).at(-1)?.payload.content ?? ''
      return (
        content.includes('First assistant update.') &&
        content.includes('Second assistant update.') &&
        content.includes('❓ **File layer**') &&
        content.includes('1. **Summon agent-minder**')
      )
    }, 1000)

    const content =
      webhook.edits.filter((edit) => edit.messageId === messageId).at(-1)?.payload.content ?? ''
    expect(content).toContain('First assistant update.')
    expect(content).toContain('Second assistant update.')
    expect(content).toContain('❓ **File layer**')
    expect(content).toContain('How do you want the file layer handled?')
    expect(content).toContain('1. **Summon agent-minder**')
    // Both prose segments keep their arrival order around the tool line.
    expect(content.indexOf('First assistant update.')).toBeLessThan(
      content.indexOf('📖 Read: /tmp/example.txt')
    )
    expect(content.indexOf('📖 Read: /tmp/example.txt')).toBeLessThan(
      content.indexOf('Second assistant update.')
    )
  })

  test('steers replies into an active AskUserQuestion placeholder without dashboard state', async () => {
    const harness = createLiveProgressHarness({
      interfaceMessageResponse: (ingressCount) =>
        ingressCount === 1
          ? {
              inputAttemptId: 'ia_live_progress',
              runId: 'run_live_progress',
              hostSessionId: 'hsid_live_progress',
              generation: 7,
            }
          : {
              inputAttemptId: 'ia_answer',
              targetRunId: 'run_live_progress',
              admission: {
                kind: 'accepted_in_flight',
                inputAttemptId: 'ia_answer',
                inputApplicationId: 'iap_answer',
              },
              currentState: {
                applicationStatus: 'accepted',
                inputApplicationId: 'iap_answer',
              },
            },
    })
    await harness.app.refreshBindings()
    await harness.app.handleMessageCreate(harness.inboundMessage())

    harness.emit(assistantTurnMessage(1, 'H2 step 1'))
    harness.emit(
      hrcTurnEvent(2, 'turn.tool_call', {
        type: 'tool_execution_start',
        toolUseId: 'tool_question',
        toolName: 'AskUserQuestion',
        input: {
          questions: [
            {
              header: 'Fruit',
              question: 'H2: pick a fruit',
              options: [
                { label: 'Apple', description: 'Choose apple.' },
                { label: 'Banana', description: 'Choose banana.' },
              ],
            },
          ],
        },
      })
    )

    const webhook = harness.webhook()
    await waitFor(() => webhook.edits.at(-1)?.payload.content.includes('H2: pick a fruit') === true)

    await harness.app.handleMessageCreate({
      ...harness.inboundMessage(),
      id: 'msg_answer',
      content: 'Apple',
    })

    expect(harness.interfaceMessages).toHaveLength(2)
    expect(harness.interfaceMessages[1]).toMatchObject({
      content: 'Apple',
      intent: {
        kind: 'contribute_to_active_run',
        fallback: 'reject',
        contributionSemantics: 'interrupt_and_continue',
      },
    })
  })

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
    expect(harness.eventRequests[0]?.searchParams.get('fromSeq')).toBe('101')
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
      const parsed = parseScopeRef(input.scopeRef)
      const line = `${JSON.stringify({
        hrcSeq: input.seq,
        streamSeq: input.seq,
        ts: new Date(Date.now() + input.seq * 1000).toISOString(),
        hostSessionId: `hsid_${sessionRef}`,
        scopeRef: input.scopeRef,
        identity: {
          kind: parsed.kind,
          agentId: parsed.agentId,
          projectId: parsed.projectId,
          taskId: parsed.taskId,
        },
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
      dashboardSnapshotImpl: async () => ({
        type: 'dashboard_snapshot',
        cursors: { lastHrcSeq: 0 },
        sessions: [],
      }),
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

function assistantTurnMessage(seq: number, text: string): Record<string, unknown> {
  return hrcTurnEvent(seq, 'turn.message', {
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
    },
  })
}

function hrcTurnEvent(
  seq: number,
  eventKind: string,
  payload: Record<string, unknown>
): Record<string, unknown> {
  return {
    hrcSeq: seq,
    streamSeq: seq,
    ts: new Date(Date.now() + seq * 1000).toISOString(),
    hostSessionId: 'hsid_live_progress',
    scopeRef: 'agent:smokey:project:agent-spaces',
    identity: { kind: 'project', agentId: 'smokey', projectId: 'agent-spaces' },
    laneRef: 'main',
    generation: 7,
    runtimeId: 'rt_live_progress',
    runId: 'hrc_run_live_progress',
    category: 'turn',
    eventKind,
    replayed: false,
    payload,
  }
}

describe('GatewayDiscordApp live progress assistant text and tool lines', () => {
  async function liveHarness() {
    const harness = createLiveProgressHarness()
    await harness.app.refreshBindings()
    await harness.app.handleMessageCreate(harness.inboundMessage())
    return harness
  }

  function latestEdit(webhook: FakeWebhook): string {
    return webhook.edits.at(-1)?.payload.content ?? ''
  }

  function occurrences(content: string, text: string): number {
    return content.split(text).length - 1
  }

  test('a turn.message carrying the streamed messageId renders the streamed text once', async () => {
    const harness = await liveHarness()
    const webhook = harness.webhook()

    harness.emit(
      hrcTurnEvent(1, 'message_start', {
        type: 'message_start',
        messageId: 'msg-streamed',
        message: { role: 'assistant', content: '' },
      })
    )
    harness.emit(
      hrcTurnEvent(2, 'message_update', {
        type: 'message_update',
        messageId: 'msg-streamed',
        textDelta: 'STREAMED-ONCE',
      })
    )
    harness.emit(toolStart(3, 'tool_after', 'Read', { file_path: '/after.ts' }))
    harness.emit(
      hrcTurnEvent(4, 'turn.message', {
        type: 'message_end',
        messageId: 'msg-streamed',
        message: { role: 'assistant', content: 'STREAMED-ONCE' },
      })
    )
    await waitFor(() => latestEdit(webhook).includes('📖 Read: /after.ts'), 1000)
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(occurrences(latestEdit(webhook), 'STREAMED-ONCE')).toBe(1)
  })

  test('an anchorless cumulative message_end after a streamed message renders the text once', async () => {
    const harness = await liveHarness()
    const webhook = harness.webhook()

    harness.emit(
      hrcTurnEvent(1, 'message_start', {
        type: 'message_start',
        messageId: 'msg-streamed',
        message: { role: 'assistant', content: '' },
      })
    )
    harness.emit(
      hrcTurnEvent(2, 'message_update', {
        type: 'message_update',
        messageId: 'msg-streamed',
        textDelta: 'CUMULATIVE-ONCE',
      })
    )
    harness.emit(
      hrcTurnEvent(3, 'message_end', {
        type: 'message_end',
        messageId: 'msg-streamed',
        message: { role: 'assistant', content: 'CUMULATIVE-ONCE' },
      })
    )
    harness.emit(
      hrcTurnEvent(4, 'message_end', {
        type: 'message_end',
        message: { role: 'assistant', content: 'CUMULATIVE-ONCE' },
      })
    )
    harness.emit(toolStart(5, 'tool_after', 'Read', { file_path: '/after.ts' }))
    await waitFor(() => latestEdit(webhook).includes('📖 Read: /after.ts'), 1000)

    expect(occurrences(latestEdit(webhook), 'CUMULATIVE-ONCE')).toBe(1)
  })

  test('an id-less streamed message closed by a tool is not duplicated by its id-less message_end', async () => {
    const harness = await liveHarness()
    const webhook = harness.webhook()

    harness.emit(
      hrcTurnEvent(1, 'message_start', {
        type: 'message_start',
        message: { role: 'assistant', content: '' },
      })
    )
    harness.emit(
      hrcTurnEvent(2, 'message_update', { type: 'message_update', textDelta: 'NOID-BEFORE' })
    )
    harness.emit(toolStart(3, 'tool_mid', 'Read', { file_path: '/mid.ts' }))
    harness.emit(toolEnd(4, 'tool_mid', 'Read'))
    harness.emit(
      hrcTurnEvent(5, 'message_end', {
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: 'NOID-BEFORE' }] },
      })
    )
    harness.emit(toolStart(6, 'tool_last', 'Read', { file_path: '/last.ts' }))
    await waitFor(() => latestEdit(webhook).includes('📖 Read: /last.ts'), 1000)

    const content = latestEdit(webhook)
    expect(occurrences(content, 'NOID-BEFORE')).toBe(1)
    expect(content.indexOf('NOID-BEFORE')).toBeLessThan(content.indexOf('📖 Read: /mid.ts'))
  })

  test('a message_end-only assistant turn renders once even when turn_end repeats it as finalOutput', async () => {
    const harness = await liveHarness()
    const webhook = harness.webhook()

    harness.emit(toolStart(1, 'tool_codex', 'Read', { file_path: '/c.ts' }))
    harness.emit(toolEnd(2, 'tool_codex', 'Read'))
    harness.emit(
      hrcTurnEvent(3, 'message_end', {
        type: 'message_end',
        messageId: 'msg-codex',
        message: { role: 'assistant', content: [{ type: 'text', text: 'CODEX-FINAL' }] },
      })
    )
    harness.emit(
      hrcTurnEvent(4, 'turn_end', { type: 'turn_end', payload: { finalOutput: 'CODEX-FINAL' } })
    )
    await waitFor(() => latestEdit(webhook).includes('CODEX-FINAL'), 1000)
    await new Promise((resolve) => setTimeout(resolve, 50))

    const content = latestEdit(webhook)
    expect(occurrences(content, 'CODEX-FINAL')).toBe(1)
    expect(content.indexOf('📖 Read: /c.ts')).toBeLessThan(content.indexOf('CODEX-FINAL'))
  })

  test('each tool renders its emoji and primary argument as one progress line', async () => {
    const harness = await liveHarness()
    const webhook = harness.webhook()
    const rows: Array<[string, Record<string, unknown>, string]> = [
      ['Write', { file_path: '/w.ts' }, '✍️ Write: /w.ts'],
      ['Edit', { file_path: '/e.ts' }, '🔧 Edit: /e.ts'],
      ['Grep', { pattern: 'TODO', path: '/src' }, '🔎 Grep: TODO'],
      ['Glob', { pattern: '**/*.ts' }, '📁 Glob: **/*.ts'],
      ['Task', { description: 'Run tests' }, '🤖 Task: Run tests'],
      ['WebFetch', { url: 'https://example.com' }, '📄 WebFetch: https://example.com'],
      ['WebSearch', { query: 'bun test runner' }, '🔍 WebSearch: bun test runner'],
      ['NotebookEdit', { notebook_path: '/nb.ipynb' }, '📓 NotebookEdit: /nb.ipynb'],
      ['TodoWrite', { todos: [{ text: 'a' }, { text: 'b' }] }, '📋 TodoWrite: 2 todos'],
      ['TodoWrite', { todos: [{ text: 'a' }] }, '📋 TodoWrite: 1 todo'],
      ['CustomTool', { count: 42, path: '/foo' }, '⚙️ CustomTool: /foo'],
    ]
    rows.forEach(([toolName, input], index) => {
      harness.emit(toolStart(index + 1, `tool_${index}`, toolName, input))
    })
    await waitFor(() => latestEdit(webhook).includes('⚙️ CustomTool: /foo'), 2000)

    const lines = latestEdit(webhook).split('\n')
    for (const [, , expected] of rows) {
      expect(lines).toContain(expected)
    }
  })

  test('keeps the latest twelve notices inline and truncates a long notice to the line cap', async () => {
    const harness = await liveHarness()
    const webhook = harness.webhook()
    const notice = (seq: number, level: string, message: string) =>
      hrcTurnEvent(seq, 'notice', { type: 'notice', level, message })

    harness.emit(notice(1, 'info', 'connected to live session stream'))
    harness.emit(notice(2, 'warn', 'tool output was compacted'))
    harness.emit(notice(3, 'error', 'tool progress edit failed'))
    for (let index = 0; index < 11; index += 1) {
      harness.emit(notice(index + 4, 'info', `extra notice ${index}`))
    }
    harness.emit(notice(15, 'info', `LONG-NOTICE ${'x'.repeat(200)}`))
    await waitFor(() => latestEdit(webhook).includes('LONG-NOTICE'), 1000)

    const content = latestEdit(webhook)
    expect(content).toContain('_... +3 earlier tools_')
    expect(content).not.toContain('connected to live session stream')
    expect(content).not.toContain('tool output was compacted')
    expect(content).not.toContain('tool progress edit failed')
    expect(content).toContain('ℹ️ extra notice 0')
    expect(content).toContain('ℹ️ extra notice 10')
    const noticeLines = content
      .split('\n')
      .filter((line) => line.startsWith('ℹ️ ') || line.startsWith('⚠️ ') || line.startsWith('❌ '))
    expect(noticeLines).toHaveLength(12)
    const longLine = noticeLines.find((line) => line.includes('LONG-NOTICE')) ?? ''
    expect(longLine.length).toBeLessThanOrEqual(80)
    expect(longLine.endsWith('...')).toBe(true)
  })
})
