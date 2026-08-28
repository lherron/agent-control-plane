import { describe, expect, test } from 'bun:test'
import type { WorkClient, WrkqEnvelope } from '@wrkq/client'
import { openInterfaceStore } from 'acp-interface-store'
import { DiscordLedgerHumanEgress } from '../ledger-human-egress.js'

function envelope(presented = false): WrkqEnvelope {
  return {
    uuid: 'envelope-uuid',
    id: 'EN-00042',
    roomUuid: 'room-uuid',
    roomKey: 'T-00001',
    roomKind: 'task',
    groupId: 'EN-00042',
    from: { principalRef: 'agent:smokey', scopeRef: 'smokey@agent-control-plane:T-00001' },
    to: { principalRef: 'agent:lance' },
    replyTo: 'smokey@agent-control-plane:T-00001',
    obligation: 'reply_required',
    body: 'ledger reply',
    state: presented ? 'presented' : 'pending',
    terminal: false,
    roundCount: 0,
    urgent: false,
    meta: {},
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

describe('Discord ledger human egress', () => {
  test('posts a scope-less human envelope once and records a Discord presentation', async () => {
    const store = openInterfaceStore({ dbPath: ':memory:' })
    store.discordLedgerProjection.advanceCursor('discord', 40)
    store.discordLedgerProjection.recordRoute({
      gatewayId: 'discord',
      roomUuid: 'room-uuid',
      roomKey: 'T-00001',
      bindingId: 'binding-1',
      conversationRef: 'channel:1',
      threadRef: 'thread:2',
      humanPrincipalRef: 'agent:lance',
    })

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
            return { envelope: envelope(true), recorded: true, historyHint: false, messageCount: 1 }
          },
        },
      },
    } as unknown as WorkClient
    const sent: string[] = []
    const egress = new DiscordLedgerHumanEgress({
      gatewayId: 'discord',
      client,
      store,
      send: async ({ envelope: value }) => {
        sent.push(value.body)
        return { messageId: 'discord-message-1' }
      },
    })

    expect(await egress.pollOnce()).toBe(41)
    expect(await egress.pollOnce()).toBe(41)
    expect(sent).toEqual(['ledger reply'])
    expect(presented).toEqual([
      {
        envelope: 'EN-00042',
        memberRef: 'agent:lance',
        principalRef: 'agent:gateway-discord',
        driveAttemptId: 'discord-message-1',
        deliveryOutcome: 'discord',
      },
    ])
    store.close()
  })
})
