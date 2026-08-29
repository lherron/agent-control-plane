import { describe, expect, test } from 'bun:test'
import type { WorkClient, WrkqEnvelope } from '@wrkq/client'
import { openInterfaceStore } from 'acp-interface-store'
import { parseScopeRef } from 'agent-scope'
import {
  DiscordLedgerEgress,
  chatCard,
  humanNotice,
  resolveEnvelopeSinks,
} from '../ledger-human-egress.js'
import type { WebhookPayload } from '../webhooks.js'

function envelope(
  input: {
    presented?: boolean
    to?: WrkqEnvelope['to']
    obligation?: WrkqEnvelope['obligation']
    meta?: Record<string, unknown>
    idempotencyKey?: string
    body?: string
  } = {}
): WrkqEnvelope {
  const presented = input.presented === true
  return {
    uuid: 'envelope-uuid',
    id: 'EN-00042',
    roomUuid: 'room-uuid',
    roomKey: 'T-00001',
    roomKind: 'task',
    groupId: 'EN-00042',
    from: {
      principalRef: 'agent:smokey',
      scopeRef: 'smokey@agent-control-plane:T-00001',
    },
    to: input.to === undefined ? { principalRef: 'agent:lance' } : input.to,
    replyTo: 'smokey@agent-control-plane:T-00001',
    obligation: input.obligation ?? 'reply_required',
    body: input.body ?? 'ledger reply',
    taskId: 'T-00001',
    state: presented ? 'presented' : 'pending',
    terminal: false,
    roundCount: 0,
    urgent: false,
    ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
    meta: input.meta ?? {},
    presentedTo: presented
      ? [
          {
            memberRef: 'agent:lance',
            deliveryOutcome: 'discord',
            driveAttemptId: 'discord-message-old',
            presentedAt: '2026-08-28T00:00:00Z',
          },
        ]
      : [],
    etag: 1,
    createdAt: '2026-08-28T00:00:00Z',
    updatedAt: '2026-08-28T00:00:00Z',
  }
}

const route = {
  gatewayId: 'discord',
  roomUuid: 'room-uuid',
  roomKey: 'T-00001',
  bindingId: 'binding-1',
  conversationRef: 'channel:1',
  threadRef: 'thread:2',
  humanPrincipalRef: 'agent:lance',
}

function firstEmbed(payload: WebhookPayload): Record<string, unknown> {
  return payload.embeds?.[0] as Record<string, unknown>
}

describe('Discord ledger routing and renders', () => {
  test('T1 fans a routed human envelope out to both sinks', () => {
    const sinks = resolveEnvelopeSinks(envelope(), {
      controlPlaneChannelId: 'control-plane',
      projectId: 'agent-control-plane',
      route,
    })
    expect(sinks.map((sink) => [sink.kind, sink.channelId])).toEqual([
      ['mirror', 'control-plane'],
      ['human-notice', '2'],
    ])
    expect(sinks[0]?.payload.username).toBe('smokey@agent-control-plane:T-00001')
    expect(sinks[0]?.payload.avatar_url).toBe('https://api.dicebear.com/7.x/bottts/png?seed=smokey')
    expect(firstEmbed(sinks[0]?.payload as WebhookPayload)).toEqual({
      title: '↪ -> agent:lance',
      color: 0xe0a23c,
      description: expect.stringMatching(
        /^-# T-00001 \. agent-control-plane \. EN-00042 \. \[Open task\]\(.+\)\n\nledger reply$/
      ),
    })
    expect(sinks[1]?.payload).toEqual({
      content: '-# smokey@agent-control-plane:T-00001 . EN-00042\nledger reply',
    })
  })

  test('T2 sends a scoped seat-to-seat envelope only to the mirror', () => {
    expect(
      resolveEnvelopeSinks(
        envelope({
          to: {
            principalRef: 'agent:daedalus',
            scopeRef: 'daedalus@agent-control-plane:primary',
          },
        }),
        {
          controlPlaneChannelId: 'control-plane',
          projectId: 'agent-control-plane',
          route,
        }
      ).map((sink) => sink.kind)
    ).toEqual(['mirror'])
  })

  test('T4 mirrors origin- and interface-key-shaped envelopes without suppression', () => {
    for (const value of [
      envelope({ meta: { origin: 'discord', gatewayId: 'discord' } }),
      envelope({ idempotencyKey: 'interface:discord:message-42' }),
    ]) {
      expect(
        resolveEnvelopeSinks(value, {
          controlPlaneChannelId: 'control-plane',
          projectId: 'agent-control-plane',
        }).map((sink) => sink.kind)
      ).toEqual(['mirror'])
    }
  })

  test('T8 does not select the mirror when its channel is unset', () => {
    const value = envelope({
      to: {
        principalRef: 'agent:daedalus',
        scopeRef: 'daedalus@agent-control-plane:primary',
      },
    })
    expect(resolveEnvelopeSinks(value, { projectId: 'agent-control-plane' })).toEqual([])
  })

  test('T9 renders handle-form refs that parseScopeRef rejects', () => {
    const value = envelope()
    value.from = { principalRef: 'agent:clod', scopeRef: 'clod@wrkq:primary' }
    expect(() => parseScopeRef(value.from.scopeRef as string)).toThrow()

    const card = chatCard(value, 'agent-control-plane')
    expect(card.username).toBe('clod@wrkq:primary')
    expect(firstEmbed(card)['title']).toBe('↪ -> agent:lance')
  })

  test('T10 puts the EN id in both renders independently of mirror configuration', () => {
    const value = envelope()
    expect(firstEmbed(chatCard(value, 'agent-control-plane'))['description']).toContain(value.id)
    expect(humanNotice(value).content).toContain(value.id)

    const sinks = resolveEnvelopeSinks(value, { route })
    expect(sinks.map((sink) => sink.kind)).toEqual(['human-notice'])
    expect(sinks[0]?.payload.content).toContain(value.id)
  })

  test('colors and glyphs follow obligation rather than envelope state', () => {
    const fyi = firstEmbed(chatCard(envelope({ obligation: 'fyi' }), 'agent-control-plane'))
    const logEntry = firstEmbed(
      chatCard(envelope({ obligation: 'none', to: null }), 'agent-control-plane')
    )
    expect([fyi['title'], fyi['color']]).toEqual(['▸ -> agent:lance', 0x7c8595])
    expect([logEntry['title'], logEntry['color']]).toEqual(['· -> room', 0x4b5563])
  })

  test('omits the task link when room-project lookup is unavailable', () => {
    expect(firstEmbed(chatCard(envelope(), undefined))['description']).not.toContain('Open task')
  })

  test("truncates the complete mirror description to Discord's 4096-character cap", () => {
    const description = firstEmbed(
      chatCard(envelope({ body: 'x'.repeat(5000) }), 'agent-control-plane')
    )['description'] as string
    expect(description.length).toBe(4096)
    expect(description.endsWith('…')).toBe(true)
  })
})

describe('Discord ledger human egress', () => {
  test('T3 sends both sinks independently and records a presentation only for Sink B', async () => {
    const store = openInterfaceStore({ dbPath: ':memory:' })
    store.discordLedgerProjection.advanceCursor('discord', 40)
    store.discordLedgerProjection.recordRoute(route)

    const presented: unknown[] = []
    const client = {
      call: async (_method: string, params: { cursor: number }) =>
        params.cursor === 40
          ? {
              items: [
                {
                  id: 41,
                  timestamp: '2026-08-28T00:00:01Z',
                  resource_id: 'EN-00042',
                  event_type: 'envelope.created',
                  payload: JSON.stringify({
                    id: 'EN-00042',
                    room_uuid: 'room-uuid',
                    to_principal_ref: 'agent:lance',
                  }),
                },
              ],
              high_water: 41,
            }
          : { items: [], high_water: params.cursor },
      wrkq: {
        envelope: {
          show: async () => envelope(),
          present: async (params: unknown) => {
            presented.push(params)
            return {
              envelope: envelope({ presented: true }),
              recorded: true,
              historyHint: false,
              messageCount: 1,
            }
          },
        },
        room: {
          show: async () => ({ workRef: { path: 'agent-control-plane/task' } }),
        },
      },
    } as unknown as WorkClient
    const sent: string[] = []
    const egress = new DiscordLedgerEgress({
      gatewayId: 'discord',
      client,
      store,
      controlPlaneChannelId: 'control-plane',
      maxDeliveryAttempts: 3,
      findRecentMessageId: async () => undefined,
      send: async (sink) => {
        sent.push(sink.kind)
        return { messageId: `discord-message-${sent.length}` }
      },
    })

    expect(await egress.pollOnce()).toBe(41)
    expect(await egress.pollOnce()).toBe(41)
    expect(sent).toEqual(['mirror', 'human-notice'])
    expect(presented).toEqual([
      {
        envelope: 'EN-00042',
        memberRef: 'agent:lance',
        principalRef: 'agent:gateway-discord',
        driveAttemptId: 'discord-message-2',
        deliveryOutcome: 'discord',
      },
    ])
    store.close()
  })

  test('attempts Sink B and writes its receipt even when Sink A fails', async () => {
    const store = openInterfaceStore({ dbPath: ':memory:' })
    store.discordLedgerProjection.advanceCursor('discord', 40)
    store.discordLedgerProjection.recordRoute(route)

    const presented: unknown[] = []
    const client = {
      call: async (_method: string, params: { cursor: number }) =>
        params.cursor === 40
          ? {
              items: [
                {
                  id: 41,
                  timestamp: '2026-08-28T00:00:01Z',
                  event_type: 'envelope.created',
                  payload: JSON.stringify({
                    id: 'EN-00042',
                    room_uuid: 'room-uuid',
                    to_principal_ref: 'agent:lance',
                  }),
                },
              ],
              high_water: 41,
            }
          : { items: [], high_water: params.cursor },
      wrkq: {
        envelope: {
          show: async () => envelope(),
          present: async (params: unknown) => {
            presented.push(params)
            return {
              envelope: envelope({ presented: true }),
              recorded: true,
              historyHint: false,
              messageCount: 1,
            }
          },
        },
        room: {
          show: async () => ({ workRef: { path: 'agent-control-plane/task' } }),
        },
      },
    } as unknown as WorkClient
    const attempted: string[] = []
    const egress = new DiscordLedgerEgress({
      gatewayId: 'discord',
      client,
      store,
      controlPlaneChannelId: 'control-plane',
      maxDeliveryAttempts: 3,
      findRecentMessageId: async () => undefined,
      send: async (sink) => {
        attempted.push(sink.kind)
        if (sink.kind === 'mirror') throw new Error('mirror unavailable')
        return { messageId: 'human-message' }
      },
    })

    expect(egress.pollOnce()).rejects.toThrow('Discord ledger egress failed for EN-00042')
    expect(attempted).toEqual(['mirror', 'human-notice'])
    expect(presented).toHaveLength(1)
    store.close()
  })

  test('T5 reconciles both sinks from the last 100 messages without resending', async () => {
    const store = openInterfaceStore({ dbPath: ':memory:' })
    store.discordLedgerProjection.recordRoute(route)
    for (const target of [
      { sink: 'mirror', channelId: 'control-plane' },
      { sink: 'human-notice', channelId: '2', bindingId: route.bindingId },
    ]) {
      store.discordLedgerDeliveries.beginAttempt({
        gatewayId: 'discord',
        envelopeId: 'EN-00042',
        ...target,
        maxAttempts: 3,
      })
    }

    const presented: unknown[] = []
    const client = {
      wrkq: {
        envelope: {
          show: async () => envelope(),
          present: async (params: unknown) => {
            presented.push(params)
            return {
              envelope: envelope({ presented: true }),
              recorded: true,
              historyHint: false,
              messageCount: 1,
            }
          },
        },
      },
    } as unknown as WorkClient
    const sent: string[] = []
    const egress = new DiscordLedgerEgress({
      gatewayId: 'discord',
      client,
      store,
      maxDeliveryAttempts: 3,
      findRecentMessageId: async (channelId) => `found-${channelId}`,
      send: async (sink) => {
        sent.push(sink.kind)
        return { messageId: `resent-${sink.kind}` }
      },
    })

    expect(await egress.reconcileAttempting()).toBe(2)
    expect(sent).toEqual([])
    expect(store.discordLedgerDeliveries.listByEnvelope('discord', 'EN-00042')).toEqual([
      expect.objectContaining({
        sink: 'human-notice',
        state: 'sent',
        discordMessageId: 'found-2',
        attempts: 1,
      }),
      expect.objectContaining({
        sink: 'mirror',
        state: 'sent',
        discordMessageId: 'found-control-plane',
        attempts: 1,
      }),
    ])
    expect(presented).toEqual([
      expect.objectContaining({
        envelope: 'EN-00042',
        driveAttemptId: 'found-2',
        deliveryOutcome: 'discord',
      }),
    ])
    store.close()
  })

  test('T5 resends both sinks when the reconciliation window misses', async () => {
    const store = openInterfaceStore({ dbPath: ':memory:' })
    store.discordLedgerProjection.recordRoute(route)
    for (const target of [
      { sink: 'mirror', channelId: 'control-plane' },
      { sink: 'human-notice', channelId: '2', bindingId: route.bindingId },
    ]) {
      store.discordLedgerDeliveries.beginAttempt({
        gatewayId: 'discord',
        envelopeId: 'EN-00042',
        ...target,
        maxAttempts: 3,
      })
    }

    const client = {
      wrkq: {
        envelope: {
          show: async () => envelope(),
          present: async () => ({
            envelope: envelope({ presented: true }),
            recorded: true,
            historyHint: false,
            messageCount: 1,
          }),
        },
        room: {
          show: async () => ({ workRef: { path: 'agent-control-plane/task' } }),
        },
      },
    } as unknown as WorkClient
    const sent: string[] = []
    const egress = new DiscordLedgerEgress({
      gatewayId: 'discord',
      client,
      store,
      maxDeliveryAttempts: 3,
      findRecentMessageId: async () => undefined,
      send: async (sink) => {
        sent.push(sink.kind)
        return { messageId: `resent-${sink.kind}` }
      },
    })

    expect(await egress.reconcileAttempting()).toBe(2)
    expect(sent).toEqual(['human-notice', 'mirror'])
    expect(
      store.discordLedgerDeliveries
        .listByEnvelope('discord', 'EN-00042')
        .map((delivery) => [delivery.sink, delivery.state, delivery.attempts])
    ).toEqual([
      ['human-notice', 'sent', 2],
      ['mirror', 'sent', 2],
    ])
    store.close()
  })

  test('T5b bounds repeated crash-then-reconcile cycles beyond the ceiling', async () => {
    const store = openInterfaceStore({ dbPath: ':memory:' })
    const maxDeliveryAttempts = 3
    store.discordLedgerDeliveries.beginAttempt({
      gatewayId: 'discord',
      envelopeId: 'EN-00042',
      sink: 'mirror',
      channelId: 'control-plane',
      maxAttempts: maxDeliveryAttempts,
    })

    const client = {
      wrkq: {
        envelope: { show: async () => envelope() },
        room: {
          show: async () => ({ workRef: { path: 'agent-control-plane/task' } }),
        },
      },
    } as unknown as WorkClient
    let acceptedPosts = 1
    const cycles = maxDeliveryAttempts + 3
    for (let cycle = 0; cycle < cycles; cycle += 1) {
      const restarted = new DiscordLedgerEgress({
        gatewayId: 'discord',
        client,
        store,
        maxDeliveryAttempts,
        findRecentMessageId: async () => undefined,
        send: async () => {
          acceptedPosts += 1
          throw new Error('simulated crash after Discord accepted the post')
        },
      })
      try {
        await restarted.reconcileAttempting()
      } catch {
        // A real process would disappear here. The next object is its restart.
      }
    }

    expect(cycles).toBeGreaterThan(maxDeliveryAttempts)
    expect(acceptedPosts).toBe(maxDeliveryAttempts)
    expect(
      store.discordLedgerDeliveries.get({
        gatewayId: 'discord',
        envelopeId: 'EN-00042',
        sink: 'mirror',
      })
    ).toEqual(
      expect.objectContaining({
        state: 'failed',
        attempts: maxDeliveryAttempts,
        failureReason: 'simulated crash after Discord accepted the post',
      })
    )
    expect(store.discordLedgerDeliveries.listAttempting('discord')).toEqual([])
    store.close()
  })

  test('T6 advances after a poison sink fails and still delivers a later envelope', async () => {
    const store = openInterfaceStore({ dbPath: ':memory:' })
    store.discordLedgerProjection.advanceCursor('discord', 40)
    const events = [
      {
        id: 41,
        timestamp: '2026-08-28T00:00:01Z',
        event_type: 'envelope.created',
        payload: JSON.stringify({ id: 'EN-00041', room_uuid: 'room-uuid' }),
      },
      {
        id: 42,
        timestamp: '2026-08-28T00:00:02Z',
        event_type: 'envelope.created',
        payload: JSON.stringify({ id: 'EN-00042', room_uuid: 'room-uuid' }),
      },
    ]
    const client = {
      call: async (_method: string, params: { cursor: number }) => ({
        items: events.filter((event) => event.id > params.cursor),
        high_water: 42,
      }),
      wrkq: {
        envelope: {
          show: async ({ envelope: id }: { envelope: string }) => {
            const value = envelope({
              to: {
                principalRef: 'agent:daedalus',
                scopeRef: 'daedalus@agent-control-plane:primary',
              },
            })
            value.id = id
            value.groupId = id
            return value
          },
        },
        room: {
          show: async () => ({ workRef: { path: 'agent-control-plane/task' } }),
        },
      },
    } as unknown as WorkClient
    const sent: string[] = []
    const egress = new DiscordLedgerEgress({
      gatewayId: 'discord',
      client,
      store,
      controlPlaneChannelId: 'control-plane',
      maxDeliveryAttempts: 2,
      findRecentMessageId: async () => undefined,
      send: async (sink) => {
        sent.push(sink.envelope.id)
        if (sink.envelope.id === 'EN-00041') throw new Error('poison')
        return { messageId: `message-${sink.envelope.id}` }
      },
    })

    await expect(egress.pollOnce()).rejects.toThrow('Discord ledger egress failed for EN-00041')
    expect(store.discordLedgerProjection.getCursor('discord')).toBe(40)
    expect(await egress.pollOnce()).toBe(42)
    expect(sent).toEqual(['EN-00041', 'EN-00041', 'EN-00042'])
    expect(
      store.discordLedgerDeliveries.get({
        gatewayId: 'discord',
        envelopeId: 'EN-00041',
        sink: 'mirror',
      })
    ).toEqual(expect.objectContaining({ state: 'failed', attempts: 2 }))
    expect(
      store.discordLedgerDeliveries.get({
        gatewayId: 'discord',
        envelopeId: 'EN-00042',
        sink: 'mirror',
      })
    ).toEqual(expect.objectContaining({ state: 'sent', attempts: 1 }))
    store.close()
  })
})
