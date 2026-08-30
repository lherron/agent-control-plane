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
})
