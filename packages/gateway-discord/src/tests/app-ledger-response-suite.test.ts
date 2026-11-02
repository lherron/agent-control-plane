import { expect, test } from 'bun:test'
import type { WorkClient, WrkqEnvelope } from '@wrkq/client'
import { openInterfaceStore } from 'acp-interface-store'
import { GatewayDiscordApp } from '../app.js'
import { type CapturedInterfaceMessage, createFetch } from './app-acp-fixture.test.js'
import { FakeChannel, createClient } from './app-discord-fixture.test.js'

/** Register in the parent suite to retain the original test identities and order. */
export function registerLedgerResponseTests(): void {
  test('retains ledger-routed progress alongside the final human notice by default', async () => {
    const channel = new FakeChannel('chan_ledger_route')
    const client = createClient(channel)
    const paths: string[] = []
    const captured: CapturedInterfaceMessage[] = []
    const eventRequests: URL[] = []
    const eventEncoder = new TextEncoder()
    let eventController: ReadableStreamDefaultController<Uint8Array> | undefined
    const store = openInterfaceStore({ dbPath: ':memory:' })
    store.discordLedgerProjection.advanceCursor('discord_prod', 40)
    const ledgerEvents = [
      {
        id: 41,
        timestamp: '2026-08-31T14:38:33Z',
        resource_id: 'reply-envelope-uuid',
        event_type: 'envelope.created',
        payload: JSON.stringify({
          id: 'EN-00042',
          room_uuid: 'room_ledger_1',
          to_principal_ref: 'agent:lance',
        }),
      },
    ]
    const replyEnvelope = {
      uuid: 'reply-envelope-uuid',
      id: 'EN-00042',
      messageSeq: 42,
      roomUuid: 'room_ledger_1',
      roomKey: 'R-00001',
      roomKind: 'adhoc',
      groupId: 'EN-00042',
      from: {
        principalRef: 'agent:cody',
        scopeRef: 'cody@agent-spaces:primary',
      },
      to: { principalRef: 'agent:lance' },
      replyTo: 'cody@agent-spaces:primary',
      obligation: 'reply_required',
      body: 'ledger reply',
      state: 'pending',
      terminal: false,
      roundCount: 0,
      urgent: false,
      meta: {},
      presentedTo: [],
      etag: 1,
      createdAt: '2026-08-31T14:38:33Z',
      updatedAt: '2026-08-31T14:38:33Z',
    } as unknown as WrkqEnvelope
    const workClient = {
      call: async (_method: string, params: { cursor: number }) => ({
        items: ledgerEvents.filter((event) => event.id > params.cursor),
        high_water: 41,
      }),
      wrkq: {
        envelope: {
          show: async () => replyEnvelope,
          present: async () => ({ envelope: replyEnvelope, recorded: true }),
        },
        room: { show: async () => ({ workRef: null }) },
      },
    } as unknown as WorkClient

    const app = new GatewayDiscordApp({
      acpBaseUrl: 'http://acp.test',
      gatewayId: 'discord_prod',
      client: client as never,
      typingRefreshMs: 5,
      ledgerHumanEgress: { client: workClient, store },
      dashboardSnapshotImpl: async () => ({
        type: 'dashboard_snapshot',
        cursors: { lastHrcSeq: 100 },
        sessions: [
          {
            sessionRef: 'agent:cody:project:agent-spaces/lane:main',
            status: 'active',
            summaryStatus: 'active',
            activeTurnId: 'hrc_run_active',
            capabilities: { input: true },
          },
        ],
      }),
      fetchImpl: createFetch(async (request) => {
        const url = new URL(request.url)
        paths.push(url.pathname)

        if (url.pathname === '/v1/interface/bindings') {
          return Response.json({
            bindings: [
              {
                bindingId: 'ifb_ledger_route',
                gatewayId: 'discord_prod',
                conversationRef: 'channel:chan_ledger_route',
                scopeRef: 'agent:cody:project:agent-spaces',
                laneRef: 'main',
                sessionRef: {
                  scopeRef: 'agent:cody:project:agent-spaces',
                  laneRef: 'main',
                },
                projectId: 'agent-spaces',
                status: 'active',
                createdAt: '2026-05-07T10:00:00.000Z',
                updatedAt: '2026-05-07T10:00:00.000Z',
              },
            ],
          })
        }

        if (url.pathname === '/v1/interface/messages') {
          captured.push((await request.json()) as CapturedInterfaceMessage)
          return Response.json(
            {
              inputAttemptId: 'ia_ledger',
              admission: {
                kind: 'accepted_in_flight',
                inputAttemptId: 'ia_ledger',
                inputApplicationId: 'iap_ledger',
              },
              currentState: {
                delivery: 'collaboration_ledger',
                roomUuid: 'room_ledger_1',
                roomKey: 'R-00001',
                envelopeId: 'EN-00041',
              },
            },
            { status: 201 }
          )
        }

        if (url.pathname === '/v1/session-refs/events') {
          eventRequests.push(url)
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                eventController = controller
              },
            })
          )
        }

        return new Response('not found', { status: 404 })
      }),
    })

    await app.refreshBindings()
    await app.handleMessageCreate({
      guildId: 'guild_1',
      author: { id: 'user_1', bot: false },
      content: 'fold the new context into the active task',
      attachments: { size: 0 },
      channelId: 'chan_ledger_route',
      id: 'msg_ledger_route',
      channel: {
        isThread: () => false,
      },
      reply: async () => undefined,
    } as never)

    expect(captured).toHaveLength(1)
    const webhook = [...channel.webhooks.values()].find((w) => w.name === 'agent-pulpit')
    // The active binding is the subscription roster for ledger routes too.
    await Bun.sleep(10)
    expect(eventRequests).toHaveLength(1)
    expect(eventRequests[0]?.searchParams.get('sessionRef')).toBe(
      'agent:cody:project:agent-spaces/lane:main'
    )

    // The placeholder stays alive as the progress surface and never becomes the
    // false accepted_in_flight steer banner fixed by 11741a2.
    expect(webhook?.sent).toHaveLength(1)
    expect(webhook?.sent[0]?.message.deleted).toBe(false)
    expect(webhook?.edits.some((e) => String(e.payload.content ?? '').includes('Steered'))).toBe(
      false
    )

    const emitEvent = (hrcSeq: number, eventKind: string, payload: Record<string, unknown>) => {
      eventController?.enqueue(
        eventEncoder.encode(
          `${JSON.stringify({
            hrcSeq,
            streamSeq: hrcSeq - 100,
            ts: new Date(Date.now() + 1_000).toISOString(),
            hostSessionId: 'hsid_ledger',
            scopeRef: 'agent:cody:project:agent-spaces',
            identity: { kind: 'project', agentId: 'cody', projectId: 'agent-spaces' },
            laneRef: 'main',
            generation: 7,
            runtimeId: 'rt_ledger',
            runId: 'hrc_run_ledger',
            category: 'turn',
            eventKind,
            replayed: false,
            payload,
          })}\n`
        )
      )
    }
    emitEvent(101, 'tool_execution_start', {
      type: 'tool_execution_start',
      toolUseId: 'tool_ledger_shell',
      toolName: 'Bash',
      input: { command: 'inspect source && run checks' },
    })
    emitEvent(102, 'tool_execution_start', {
      type: 'tool_execution_start',
      toolUseId: 'tool_ledger_question',
      toolName: 'AskUserQuestion',
      input: {
        questions: [
          {
            header: 'Publish target',
            question: 'Which feed should receive this episode?',
            options: [
              { label: 'Private feed', description: 'Publish privately.' },
              { label: 'Public feed', description: 'Publish publicly.' },
            ],
          },
        ],
      },
    })
    emitEvent(103, 'turn_end', {
      type: 'turn_end',
      content: 'ledger reply',
    })
    await Bun.sleep(30)
    const liveContent = webhook?.edits.at(-1)?.payload.content ?? ''
    expect(liveContent).toContain('shell: inspect source && run checks')
    expect(liveContent).toContain('Which feed should receive this episode?')
    const pingsAtQuestion = channel.typingPings
    await Bun.sleep(15)
    expect(channel.typingPings).toBe(pingsAtQuestion)

    const egress = (app as unknown as { ledgerHumanEgress: { pollOnce(): Promise<number> } })
      .ledgerHumanEgress
    await egress.pollOnce()
    // Egress finalizes the same webhook message; there is no stale progress
    // bubble beside a separately posted reply.
    expect(webhook?.sent).toHaveLength(1)
    expect(webhook?.sent[0]?.message.deleted).toBe(false)
    expect(webhook?.edits.at(-1)?.messageId).toBe(webhook?.sent[0]?.message.id)
    expect(webhook?.edits.at(-1)?.payload.content).toContain('EN-00042')
    expect(webhook?.edits.at(-1)?.payload.content).toContain('ledger reply')
    expect(webhook?.edits.at(-1)?.payload.content).toContain('shell: inspect source && run checks')
    expect(webhook?.edits.at(-1)?.payload.content).toContain(
      'Which feed should receive this episode?'
    )
    const pingsAtReply = channel.typingPings
    await Bun.sleep(15)
    expect(channel.typingPings).toBe(pingsAtReply)

    await app.stop()
    store.close()
  })

  test('stops ledger-routed typing when the correlated input envelope fails', async () => {
    const channel = new FakeChannel('chan_ledger_failure')
    const client = createClient(channel)
    const store = openInterfaceStore({ dbPath: ':memory:' })
    store.discordLedgerProjection.advanceCursor('discord_prod', 50)
    const failedEnvelope = {
      uuid: 'failed-envelope-uuid',
      id: 'EN-00051',
      messageSeq: 51,
      roomUuid: 'room_ledger_failure',
      roomKey: 'R-00002',
      roomKind: 'adhoc',
      groupId: 'EN-00051',
      from: { principalRef: 'agent:lance' },
      to: { principalRef: 'agent:cody', scopeRef: 'cody@agent-spaces:primary' },
      replyTo: 'agent:lance',
      obligation: 'reply_required',
      body: 'please do the work',
      state: 'failed',
      terminal: true,
      failureReason: 'runtime_terminated',
      roundCount: 0,
      urgent: false,
      meta: {},
      presentedTo: [],
      etag: 2,
      createdAt: '2026-08-31T14:38:21Z',
      updatedAt: '2026-08-31T14:38:30Z',
    } as unknown as WrkqEnvelope
    const workClient = {
      call: async (_method: string, params: { cursor: number }) => ({
        items:
          params.cursor < 51
            ? [
                {
                  id: 51,
                  timestamp: '2026-08-31T14:38:30Z',
                  resource_id: 'failed-envelope-uuid',
                  event_type: 'envelope.failed',
                  payload: JSON.stringify({
                    state: 'failed',
                    reason: 'runtime_terminated',
                    room_uuid: 'room_ledger_failure',
                  }),
                },
              ]
            : [],
        high_water: 51,
      }),
      wrkq: {
        envelope: { show: async () => failedEnvelope },
        room: { show: async () => ({ workRef: null }) },
      },
    } as unknown as WorkClient
    const app = new GatewayDiscordApp({
      acpBaseUrl: 'http://acp.test',
      gatewayId: 'discord_prod',
      client: client as never,
      typingRefreshMs: 5,
      ledgerHumanEgress: { client: workClient, store },
      dashboardSnapshotImpl: async () => ({
        type: 'dashboard_snapshot',
        cursors: { lastHrcSeq: 0 },
        sessions: [],
      }),
      fetchImpl: createFetch(async (request) => {
        const url = new URL(request.url)
        if (url.pathname === '/v1/interface/bindings') {
          return Response.json({
            bindings: [
              {
                bindingId: 'ifb_ledger_failure',
                gatewayId: 'discord_prod',
                conversationRef: 'channel:chan_ledger_failure',
                scopeRef: 'agent:cody:project:agent-spaces',
                laneRef: 'main',
                projectId: 'agent-spaces',
                status: 'active',
                createdAt: '2026-05-07T10:00:00.000Z',
                updatedAt: '2026-05-07T10:00:00.000Z',
              },
            ],
          })
        }
        if (url.pathname === '/v1/interface/messages') {
          return Response.json(
            {
              inputAttemptId: 'ia_ledger_failure',
              admission: { kind: 'accepted_in_flight' },
              currentState: {
                delivery: 'collaboration_ledger',
                roomUuid: 'room_ledger_failure',
                roomKey: 'R-00002',
                envelopeId: 'EN-00051',
              },
            },
            { status: 201 }
          )
        }
        if (url.pathname === '/v1/session-refs/events') {
          return new Response(new ReadableStream())
        }
        return new Response('not found', { status: 404 })
      }),
    })

    await app.refreshBindings()
    await app.handleMessageCreate({
      guildId: 'guild_1',
      author: { id: 'user_1', bot: false },
      content: 'please do the work',
      attachments: { size: 0 },
      channelId: 'chan_ledger_failure',
      id: 'msg_ledger_failure',
      channel: { isThread: () => false },
      reply: async () => undefined,
    } as never)

    await Bun.sleep(15)
    expect(channel.typingPings).toBeGreaterThanOrEqual(2)
    const webhook = [...channel.webhooks.values()].find((w) => w.name === 'agent-pulpit')
    expect(webhook?.sent[0]?.message.deleted).toBe(false)

    const egress = (app as unknown as { ledgerHumanEgress: { pollOnce(): Promise<number> } })
      .ledgerHumanEgress
    await egress.pollOnce()
    const pingsAtFailure = channel.typingPings
    await Bun.sleep(15)
    expect(channel.typingPings).toBe(pingsAtFailure)
    expect(webhook?.sent).toHaveLength(1)
    expect(webhook?.edits).toHaveLength(1)
    expect(webhook?.edits[0]?.payload.content).toContain('Reply failed (runtime_terminated)')
    expect(webhook?.edits[0]?.payload.content).toContain('wrkc show EN-00051')
    expect(webhook?.sent[0]?.message.deleted).toBe(false)

    await app.stop()
    store.close()
  })

  test('edits an uncompleted ledger progress placeholder at the live timeout', async () => {
    const channel = new FakeChannel('chan_ledger_timeout')
    const client = createClient(channel)
    const store = openInterfaceStore({ dbPath: ':memory:' })
    store.discordLedgerProjection.advanceCursor('discord_prod', 60)
    const workClient = {
      call: async () => ({ items: [], high_water: 60 }),
      wrkq: {
        envelope: {
          show: async () => {
            throw new Error('no envelope events expected')
          },
        },
        room: { show: async () => ({ workRef: null }) },
      },
    } as unknown as WorkClient
    const app = new GatewayDiscordApp({
      acpBaseUrl: 'http://acp.test',
      gatewayId: 'discord_prod',
      client: client as never,
      typingRefreshMs: 5,
      liveProgressTimeoutMs: 15,
      ledgerHumanEgress: { client: workClient, store },
      dashboardSnapshotImpl: async () => ({
        type: 'dashboard_snapshot',
        cursors: { lastHrcSeq: 0 },
        sessions: [],
      }),
      fetchImpl: createFetch(async (request) => {
        const url = new URL(request.url)
        if (url.pathname === '/v1/interface/bindings') {
          return Response.json({
            bindings: [
              {
                bindingId: 'ifb_ledger_timeout',
                gatewayId: 'discord_prod',
                conversationRef: 'channel:chan_ledger_timeout',
                sessionRef: {
                  scopeRef: 'agent:cody:project:agent-spaces',
                  laneRef: 'main',
                },
                projectId: 'agent-spaces',
                status: 'active',
                createdAt: '2026-05-07T10:00:00.000Z',
                updatedAt: '2026-05-07T10:00:00.000Z',
              },
            ],
          })
        }
        if (url.pathname === '/v1/interface/messages') {
          return Response.json(
            {
              inputAttemptId: 'ia_ledger_timeout',
              admission: { kind: 'accepted_in_flight' },
              currentState: {
                delivery: 'collaboration_ledger',
                roomUuid: 'room_ledger_timeout',
                roomKey: 'R-00003',
                envelopeId: 'EN-00061',
              },
            },
            { status: 201 }
          )
        }
        if (url.pathname === '/v1/session-refs/events') {
          return new Response(new ReadableStream())
        }
        return new Response('not found', { status: 404 })
      }),
    })

    await app.refreshBindings()
    await app.handleMessageCreate({
      guildId: 'guild_1',
      author: { id: 'user_1', bot: false },
      content: 'please time out cleanly',
      attachments: { size: 0 },
      channelId: 'chan_ledger_timeout',
      id: 'msg_ledger_timeout',
      channel: { isThread: () => false },
      reply: async () => undefined,
    } as never)

    const webhook = [...channel.webhooks.values()].find((w) => w.name === 'agent-pulpit')
    expect(webhook?.sent[0]?.message.deleted).toBe(false)
    await Bun.sleep(30)
    expect(webhook?.sent[0]?.message.deleted).toBe(false)
    expect(webhook?.edits.at(-1)?.payload.content).toContain('Reply timed out before completion')
    expect(webhook?.edits.at(-1)?.payload.content).toContain('wrkc show EN-00061')
    const pingsAtTimeout = channel.typingPings
    await Bun.sleep(15)
    expect(channel.typingPings).toBe(pingsAtTimeout)

    await app.stop()
    store.close()
  })

  test('posts a visible ledger human-delivery failure stub when the human notice is rejected by Discord', async () => {
    const channel = new FakeChannel('chan_ledger_failure_stub')
    const webhook = await channel.createWebhook({ name: 'agent-pulpit' })
    webhook.failNextSendWith = Object.assign(new Error('Invalid Form Body'), { status: 400 })
    const client = createClient(channel)
    const store = openInterfaceStore({ dbPath: ':memory:' })
    store.discordLedgerProjection.advanceCursor('discord_prod', 70)
    store.discordLedgerProjection.recordRoute({
      gatewayId: 'discord_prod',
      roomUuid: 'room_ledger_failure_stub',
      roomKey: 'R-00004',
      bindingId: 'ifb_failure_stub',
      conversationRef: `channel:${channel.id}`,
      humanPrincipalRef: 'agent:lance',
    })
    const failedReply = {
      uuid: 'reply-failure-uuid',
      id: 'EN-00071',
      messageSeq: 71,
      roomUuid: 'room_ledger_failure_stub',
      roomKey: 'R-00004',
      roomKind: 'adhoc',
      groupId: 'EN-00071',
      from: {
        principalRef: 'agent:cody',
        scopeRef: 'cody@agent-spaces:primary',
      },
      to: { principalRef: 'agent:lance' },
      replyTo: 'cody@agent-spaces:primary',
      obligation: 'reply_required',
      body: 'full reply text',
      state: 'pending',
      terminal: false,
      meta: {},
      presentedTo: [],
      etag: 1,
      createdAt: '2026-09-01T00:00:00Z',
      updatedAt: '2026-09-01T00:00:00Z',
    } as unknown as WrkqEnvelope
    const failedEnvelopes: unknown[] = []
    const workClient = {
      call: async (_method: string, params: { cursor: number }) => ({
        items:
          params.cursor < 71
            ? [
                {
                  id: 71,
                  timestamp: '2026-09-01T00:00:00Z',
                  resource_id: 'reply-failure-uuid',
                  event_type: 'envelope.created',
                  payload: JSON.stringify({
                    id: 'EN-00071',
                    room_uuid: 'room_ledger_failure_stub',
                    to_principal_ref: 'agent:lance',
                  }),
                },
              ]
            : [],
        high_water: 71,
      }),
      wrkq: {
        envelope: {
          show: async () => failedReply,
          fail: async (params: unknown) => {
            failedEnvelopes.push(params)
            return { ...failedReply, state: 'failed' }
          },
        },
        room: { show: async () => ({ workRef: null }) },
      },
    } as unknown as WorkClient
    const app = new GatewayDiscordApp({
      acpBaseUrl: 'http://acp.test',
      gatewayId: 'discord_prod',
      client: client as never,
      ledgerHumanEgress: { client: workClient, store },
      fetchImpl: createFetch(async () => Response.json({ bindings: [] })),
    })

    const egress = (app as unknown as { ledgerHumanEgress: { pollOnce(): Promise<number> } })
      .ledgerHumanEgress
    await egress.pollOnce()

    // The rejected human notice carried the sender's scope handle and principal avatar.
    expect(webhook.sendAttempts[0]).toMatchObject({
      username: 'cody@agent-spaces:primary',
      avatarURL: 'https://api.dicebear.com/7.x/bottts/png?seed=cody',
    })
    expect(failedEnvelopes).toMatchObject([{ envelope: 'EN-00071', reason: 'undeliverable' }])
    expect(webhook.sent).toHaveLength(1)
    expect(webhook.sent[0]?.content).toBe(
      '⚠️ reply delivery failed (discord_http_400: Invalid Form Body) — full text: wrkc show EN-00071'
    )

    await app.stop()
    store.close()
  })
}
