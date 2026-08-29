import { describe, expect, test } from 'bun:test'
import type { WorkClient } from '@wrkq/client'

import { createCollaborationLedger } from '../src/collaboration.js'

function envelope(
  id: string,
  roomKey: string,
  createdAt: string,
  overrides: Record<string, unknown> = {}
) {
  return {
    id,
    roomKey,
    groupId: id,
    from: { principalRef: 'agent:clod', scopeRef: 'clod@wrkq:T-07614' },
    to: { principalRef: 'agent:cody', scopeRef: 'cody@agent-control-plane:T-07614' },
    obligation: 'reply_required',
    state: 'pending',
    body: `body ${id}`,
    createdAt,
    updatedAt: createdAt,
    presentedTo: [],
    ...overrides,
  }
}

describe('collaboration ledger adapter', () => {
  test('lists every active member room, applies a global EN cursor, and keeps correlation', async () => {
    const calls: Array<{ method: string; params: unknown }> = []
    const client = {
      wrkq: {
        room: {
          async list(params: unknown) {
            calls.push({ method: 'room.list', params })
            return { items: [{ key: 'T-07614' }, { key: 'wrkq/rooms' }] }
          },
          async logView(params: { room: string }) {
            calls.push({ method: 'room.logView', params })
            return {
              items:
                params.room === 'T-07614'
                  ? [
                      envelope('EN-00007', params.room, '2026-08-27T17:00:07Z'),
                      envelope('EN-00011', params.room, '2026-08-27T17:00:11Z'),
                    ]
                  : [
                      envelope('EN-00009', params.room, '2026-08-27T17:00:09Z', {
                        idempotencyKey: 'acp:hrc-message:msg-legacy-9',
                      }),
                    ],
            }
          },
        },
      },
    } as unknown as WorkClient

    const result = await createCollaborationLedger(client, 'agent:acp-server').listMessagesByMember(
      {
        memberRef: 'cody@agent-control-plane:T-07614',
        beforeMessageSeq: 11,
        limit: 2,
      }
    )

    expect(calls).toEqual([
      {
        method: 'room.list',
        params: {
          scope: 'me',
          principalRef: 'agent:acp-server',
          scopeRef: 'cody@agent-control-plane:T-07614',
        },
      },
      {
        method: 'room.logView',
        params: { room: 'T-07614', principalRef: 'agent:acp-server' },
      },
      {
        method: 'room.logView',
        params: { room: 'wrkq/rooms', principalRef: 'agent:acp-server' },
      },
    ])
    expect(result.messages.map((message) => message.messageId)).toEqual(['EN-00009', 'EN-00007'])
    expect(result.messages[0]?.legacyMessageId).toBe('msg-legacy-9')
    expect(result.messages[0]?.roomKey).toBe('wrkq/rooms')
  })

  test('says with the connection-matched caller principal and no from override', async () => {
    let params: unknown
    const client = {
      wrkq: {
        room: {
          async say(input: unknown) {
            params = input
            return {
              room: { key: 'T-07614' },
              groupId: 'EN-00012',
              envelopes: [
                envelope('EN-00012', 'T-07614', '2026-08-27T17:00:12Z', {
                  idempotencyKey: 'acp:hrc-message:msg-12',
                }),
              ],
            }
          },
        },
      },
    } as unknown as WorkClient

    const receipt = await createCollaborationLedger(client, 'agent:lance').say({
      ref: 'T-07614',
      to: ['cody@agent-control-plane:T-07614'],
      body: 'hello',
      idempotencyKey: 'acp:hrc-message:msg-12',
    })

    expect(params).toEqual({
      ref: 'T-07614',
      to: ['cody@agent-control-plane:T-07614'],
      body: 'hello',
      principalRef: 'agent:lance',
      idempotencyKey: 'acp:hrc-message:msg-12',
    })
    expect(params).not.toHaveProperty('from')
    expect(receipt.envelopes[0]?.legacyMessageId).toBe('msg-12')
  })

  test('presents only scope-less human addressees through the authenticated ACP caller', async () => {
    const calls: Array<{ method: string; params: unknown }> = []
    const humanEnvelope = envelope('EN-00013', 'T-07614', '2026-08-27T17:00:13Z', {
      to: { principalRef: 'agent:lance' },
    })
    const client = {
      wrkq: {
        room: {
          async logView() {
            return {
              items: [humanEnvelope, envelope('EN-00014', 'T-07614', '2026-08-27T17:00:14Z')],
            }
          },
        },
        envelope: {
          async present(params: unknown) {
            calls.push({ method: 'envelope.present', params })
            return {
              envelope: {
                ...humanEnvelope,
                state: 'presented',
                presentedTo: [{ memberRef: 'agent:lance', presentedAt: '2026-08-27T17:01:00Z' }],
              },
              recorded: true,
              historyHint: true,
              messageCount: 1,
            }
          },
        },
      },
    } as unknown as WorkClient

    const result = await createCollaborationLedger(client, 'agent:gateway-ios').listMessagesByRoom({
      roomKey: 'T-07614',
      presentToPrincipalRef: 'agent:lance',
    })

    expect(calls).toEqual([
      {
        method: 'envelope.present',
        params: {
          envelope: 'EN-00013',
          memberRef: 'agent:lance',
          principalRef: 'agent:gateway-ios',
        },
      },
    ])
    expect(result.messages.find((message) => message.messageId === 'EN-00013')?.state).toBe(
      'presented'
    )
  })

  test('projects failed terminal envelopes without aborting collaboration history', async () => {
    const client = {
      wrkq: {
        room: {
          async list() {
            return { items: [{ key: 'T-07614' }] }
          },
          async logView() {
            return {
              items: [
                envelope('EN-00015', 'T-07614', '2026-08-27T17:00:15Z', {
                  state: 'failed',
                  terminal: true,
                  failureReason: 'runtime_terminated',
                }),
              ],
            }
          },
        },
      },
    } as unknown as WorkClient

    const result = await createCollaborationLedger(client, 'agent:acp-server').listMessagesByMember(
      {
        memberRef: 'cody@agent-control-plane:T-07614',
      }
    )

    expect(result.messages).toHaveLength(1)
    expect(result.messages[0]?.state).toBe('failed')
  })
})
