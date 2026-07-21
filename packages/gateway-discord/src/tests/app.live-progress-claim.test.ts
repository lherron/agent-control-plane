import { describe, expect, test } from 'bun:test'

import { GatewayDiscordApp, eventTimestampIsClaimable } from '../app.js'
import {
  FakeChannel,
  FakeClient,
  createLiveProgressHarness,
  hrcEvent,
  toolStart,
  waitFor,
} from './live-progress-test-helpers.test.js'

describe('GatewayDiscordApp live progress run claiming', () => {
  test('compares numeric pendingSince to ISO event.ts with equality allowed', () => {
    const pendingSince = Date.parse('2026-05-06T19:00:00.000Z')

    expect(
      eventTimestampIsClaimable({
        pendingSince,
        eventTs: '2026-05-06T19:00:00.000Z',
      })
    ).toBe(true)
    expect(
      eventTimestampIsClaimable({
        pendingSince,
        eventTs: '2026-05-06T19:00:00.001Z',
      })
    ).toBe(true)
    expect(
      eventTimestampIsClaimable({
        pendingSince,
        eventTs: '2026-05-06T18:59:59.999Z',
      })
    ).toBe(false)
  })

  test('does not claim malformed or missing event timestamps', () => {
    const pendingSince = Date.parse('2026-05-06T19:00:00.000Z')

    expect(eventTimestampIsClaimable({ pendingSince, eventTs: 'not-a-date' })).toBe(false)
    expect(eventTimestampIsClaimable({ pendingSince })).toBe(false)
  })

  test('uses the claimed HRC run id to render final tool history for an ACP delivery', async () => {
    const harness = createLiveProgressHarness()
    await harness.app.refreshBindings()
    await harness.app.handleMessageCreate(harness.inboundMessage())

    harness.emit(toolStart(1, 'tool_1', 'Bash', { command: 'bun test --filter bridge' }))
    await waitFor(() => harness.webhook().edits.length > 0)

    harness.enqueueDelivery('Final answer with bridged history.')
    await harness.app.pollDeliveriesOnce()

    const content = harness.webhook().edits.at(-1)?.payload.content ?? ''
    expect(content).toContain('Final answer with bridged history.')
    expect(content).toContain('bun test --filter bridge')
  })

  test('FIFO claims concurrent pending placeholders for interleaved new runs', async () => {
    const harness = createLiveProgressHarness()
    await harness.app.refreshBindings()
    const first = harness.inboundMessage() as {
      id: string
      content: string
    }
    const second = { ...first, id: 'msg_live_progress_2', content: 'second progress prompt' }

    await Promise.all([
      harness.app.handleMessageCreate(first as never),
      harness.app.handleMessageCreate(second as never),
    ])

    harness.emit(
      hrcEvent(1, {
        type: 'tool_execution_start',
        toolUseId: 'tool_first',
        toolName: 'Bash',
        input: { command: 'first' },
      })
    )
    harness.emit({
      ...hrcEvent(2, {
        type: 'tool_execution_start',
        toolUseId: 'tool_second',
        toolName: 'Bash',
        input: { command: 'second' },
      }),
      runId: 'hrc_run_live_progress_2',
    })

    await waitFor(() => harness.webhook().edits.length >= 2)

    const editedIds = harness.webhook().edits.map((edit) => edit.messageId)
    expect(new Set(editedIds)).toEqual(new Set(['wh_1', 'wh_2']))
  })

  test('queued placeholders do not claim an already-running HRC run on the same sessionRef', async () => {
    const harness = createLiveProgressHarness({
      interfaceMessageResponse: () => ({
        inputAttemptId: 'ia_queued',
        runId: 'run_queued_future',
      }),
    })
    await harness.app.refreshBindings()
    await harness.app.handleMessageCreate(harness.inboundMessage())

    harness.emit(
      hrcEvent(1, {
        type: 'tool_execution_start',
        toolUseId: 'tool_active_other',
        toolName: 'Bash',
        input: { command: 'ssh mini ./unrelated-active-run' },
      })
    )

    await new Promise((resolve) => setTimeout(resolve, 25))

    expect(harness.webhook().edits).toHaveLength(0)
  })

  test('claims a federated AskUserQuestion by exact ACP run id and routes its answer as contribution', async () => {
    const harness = createLiveProgressHarness({
      interfaceMessageResponse: (count) =>
        count === 1
          ? { inputAttemptId: 'ia_remote_ask', runId: 'run_remote_acp' }
          : {
              inputAttemptId: 'ia_remote_answer',
              admission: { kind: 'accepted_in_flight' },
            },
    })
    await harness.app.refreshBindings()
    await harness.app.handleMessageCreate(harness.inboundMessage())

    harness.emit({
      ...hrcEvent(1, {
        type: 'tool_execution_start',
        toolUseId: 'tool_remote_ask',
        toolName: 'AskUserQuestion',
        input: {
          questions: [
            {
              question: 'Fruit?',
              header: 'Fruit',
              options: [
                { label: 'Apple', description: 'Choose Apple' },
                { label: 'Banana', description: 'Choose Banana' },
              ],
              multiSelect: false,
            },
          ],
        },
        acpRunId: 'run_remote_acp',
      }),
      eventKind: 'turn.tool_call',
      hostSessionId: 'hs_remote_lab',
      runtimeId: 'rt_remote_lab',
      runId: 'hrc_run_remote_lab',
    })

    await waitFor(() =>
      harness.webhook().edits.some((edit) => edit.payload.content.includes('Fruit?'))
    )

    const answer = {
      ...(harness.inboundMessage() as { id: string; content: string }),
      id: 'msg_remote_answer',
      content: 'Apple',
    }
    await harness.app.handleMessageCreate(answer as never)

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

  test('deduplicates live subscriptions for bindings that share a sessionRef', async () => {
    const client = new FakeClient()
    client.addChannel(new FakeChannel('chan_a'))
    client.addChannel(new FakeChannel('chan_b'))
    const eventRequests: URL[] = []
    const fetchImpl = async (
      input: string | URL | Request,
      init?: RequestInit
    ): Promise<Response> => {
      const request = input instanceof Request ? input : new Request(String(input), init)
      const url = new URL(request.url)

      if (url.pathname === '/v1/interface/bindings') {
        const binding = {
          gatewayId: 'discord_prod',
          scopeRef: 'agent:smokey:project:agent-spaces',
          laneRef: 'main',
          sessionRef: {
            scopeRef: 'agent:smokey:project:agent-spaces',
            laneRef: 'main',
          },
          projectId: 'agent-spaces',
          status: 'active',
          createdAt: '2026-05-06T19:00:00.000Z',
          updatedAt: '2026-05-06T19:00:00.000Z',
        }
        return Response.json({
          bindings: [
            { ...binding, bindingId: 'ifb_a', conversationRef: 'channel:chan_a' },
            { ...binding, bindingId: 'ifb_b', conversationRef: 'channel:chan_b' },
          ],
        })
      }

      if (url.pathname === '/v1/session-refs/events') {
        eventRequests.push(url)
        return new Response(new ReadableStream())
      }

      return new Response('not found', { status: 404 })
    }
    const app = new GatewayDiscordApp({
      acpBaseUrl: 'http://acp.test',
      gatewayId: 'discord_prod',
      client: client as never,
      fetchImpl,
    })

    await app.refreshBindings()
    expect(eventRequests).toHaveLength(1)
    expect(eventRequests[0]?.searchParams.get('sessionRef')).toBe(
      'agent:smokey:project:agent-spaces/lane:main'
    )
    await app.stop()
  })
})
