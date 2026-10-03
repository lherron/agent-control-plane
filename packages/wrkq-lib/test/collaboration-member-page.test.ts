import { describe, expect, test } from 'bun:test'
import type { WorkClient, WrkqEnvelopeMemberPageParams } from '@wrkq/client'

import { createCollaborationLedger } from '../src/collaboration.js'

describe('bounded collaboration member pages', () => {
  test('uses the typed authority page and preserves its exact cursor facts', async () => {
    const calls: WrkqEnvelopeMemberPageParams[] = []
    const client = {
      wrkq: {
        envelope: {
          async memberPage(input: WrkqEnvelopeMemberPageParams) {
            calls.push(input)
            return {
              ledgerIncarnation: 'wrkq-ledger-a',
              headMessageSeq: 91,
              hasMoreBefore: true,
              hasMoreAfter: false,
              items: [
                {
                  id: 'EN-00090',
                  seq: 90,
                  roomKey: 'T-07718',
                  groupId: 'EN-00090',
                  from: { principalRef: 'agent:lance' },
                  to: {
                    principalRef: 'agent:cody',
                    scopeRef: 'cody@agent-control-plane:T-07718',
                  },
                  obligation: 'reply_required',
                  state: 'presented',
                  body: 'bounded history',
                  taskId: 'T-07718',
                  presentedTo: [],
                  meta: {},
                  terminal: false,
                  createdAt: '2026-08-30T01:00:00.000Z',
                  updatedAt: '2026-08-30T01:01:00.000Z',
                },
              ],
            }
          },
        },
      },
    } as unknown as WorkClient

    const ledger = createCollaborationLedger(client, 'agent:cody')
    const page = await ledger.pageMessagesByMember({
      memberRef: 'cody@agent-control-plane:T-07718',
      afterMessageSeq: 88,
      expectedLedgerIncarnationId: 'wrkq-ledger-a',
      limit: 2,
    })

    expect(calls).toEqual([
      {
        memberRef: 'cody@agent-control-plane:T-07718',
        afterMessageSeq: 88,
        expectedLedgerIncarnation: 'wrkq-ledger-a',
        limit: 2,
        principalRef: 'agent:cody',
        scopeRef: 'cody@agent-control-plane:T-07718',
      },
    ])
    expect(page).toEqual({
      ledgerIncarnationId: 'wrkq-ledger-a',
      headMessageSeq: 91,
      hasMoreBefore: true,
      hasMoreAfter: false,
      messages: [
        expect.objectContaining({
          messageId: 'EN-00090',
          messageSeq: 90,
          body: 'bounded history',
        }),
      ],
    })
  })

  function memberPageClient(items: Array<Record<string, unknown>>): WorkClient {
    return {
      wrkq: {
        envelope: {
          async memberPage() {
            return {
              ledgerIncarnation: 'wrkq-ledger-b',
              headMessageSeq: 103,
              hasMoreBefore: true,
              hasMoreAfter: false,
              items,
            }
          },
        },
      },
    } as unknown as WorkClient
  }

  function memberEnvelope(seq: number, state: unknown): Record<string, unknown> {
    return {
      id: `EN-00${seq}`,
      messageSeq: seq,
      roomKey: 'T-10138',
      groupId: `EN-00${seq}`,
      from: { principalRef: 'agent:stella', scopeRef: 'stella@hrc-ios:primary-pulsar' },
      to: { principalRef: 'agent:cody', scopeRef: 'cody@agent-control-plane:T-10138' },
      obligation: 'fyi',
      state,
      body: `body ${seq}`,
      presentedTo: [],
      meta: {},
      terminal: state === 'acked' || state === 'withdrawn',
      createdAt: `2026-10-03T13:00:${seq - 100}0.000Z`,
      updatedAt: `2026-10-03T13:00:${seq - 100}0.000Z`,
    }
  }

  test('preserves an unknown future envelope state verbatim beside known neighbours', async () => {
    const ledger = createCollaborationLedger(
      memberPageClient([
        memberEnvelope(101, 'acked'),
        memberEnvelope(102, 'quarantined'),
        memberEnvelope(103, 'withdrawn'),
      ]),
      'agent:cody'
    )

    const page = await ledger.pageMessagesByMember({
      memberRef: 'cody@agent-control-plane:T-10138',
      beforeMessageSeq: 104,
      limit: 3,
    })

    expect(page.ledgerIncarnationId).toBe('wrkq-ledger-b')
    expect(page.headMessageSeq).toBe(103)
    expect(page.hasMoreBefore).toBe(true)
    expect(page.hasMoreAfter).toBe(false)
    expect(
      page.messages.map(({ messageId, messageSeq, state, body }) => ({
        messageId,
        messageSeq,
        state,
        body,
      }))
    ).toEqual([
      { messageId: 'EN-00101', messageSeq: 101, state: 'acked', body: 'body 101' },
      { messageId: 'EN-00102', messageSeq: 102, state: 'quarantined', body: 'body 102' },
      { messageId: 'EN-00103', messageSeq: 103, state: 'withdrawn', body: 'body 103' },
    ])
  })

  test.each([
    ['missing', undefined],
    ['null', null],
    ['numeric', 7],
    ['empty', ''],
    ['blank', '   '],
  ])('rejects a %s envelope state', async (_label, state) => {
    const ledger = createCollaborationLedger(
      memberPageClient([memberEnvelope(101, state)]),
      'agent:cody'
    )

    await expect(
      ledger.pageMessagesByMember({
        memberRef: 'cody@agent-control-plane:T-10138',
        beforeMessageSeq: 104,
        limit: 1,
      })
    ).rejects.toThrow('invalid collaboration state on EN-00101')
  })
})
