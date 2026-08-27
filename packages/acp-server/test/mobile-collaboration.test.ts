import { describe, expect, test } from 'bun:test'
import type { HrcMessageRecord } from 'hrc-core'
import type { CollaborationLedger, CollaborationMessage, CollaborationSayInput } from 'wrkq-lib'

import type { AcpHrcClient } from '../src/deps.js'
import { withWiredServer } from './fixtures/wired-server.js'

const SESSION_REF = 'agent:cody:project:agent-control-plane:task:T-07614/lane:main'
const MEMBER_REF = 'cody@agent-control-plane:T-07614'

function hrcMessage(messageId = 'msg-legacy'): HrcMessageRecord {
  return {
    messageSeq: 4,
    messageId,
    createdAt: '2026-08-27T17:00:00.000Z',
    kind: 'dm',
    phase: 'request',
    from: { kind: 'entity', entity: 'human' },
    to: { kind: 'session', sessionRef: SESSION_REF },
    rootMessageId: messageId,
    body: 'ledger-backed mobile prompt',
    bodyFormat: 'text/plain',
    execution: { state: 'accepted', sessionRef: SESSION_REF },
  }
}

function ledgerMessage(overrides: Partial<CollaborationMessage> = {}): CollaborationMessage {
  return {
    messageId: 'EN-00005',
    messageSeq: 5,
    roomKey: 'T-07614',
    groupId: 'EN-00005',
    sender: { principalRef: 'agent:lance' },
    recipient: { principalRef: 'agent:cody', scopeRef: MEMBER_REF },
    obligation: 'reply_required',
    state: 'pending',
    body: 'ledger-backed mobile prompt',
    taskId: 'T-07614',
    createdAt: '2026-08-27T17:00:01.000Z',
    updatedAt: '2026-08-27T17:00:01.000Z',
    ...overrides,
  }
}

function ledger(input: {
  messages?: CollaborationMessage[]
  sayCalls?: CollaborationSayInput[]
}): CollaborationLedger {
  return {
    async listMessagesByMember() {
      return { messages: input.messages ?? [] }
    },
    async listMessagesByRoom() {
      return { messages: input.messages ?? [] }
    },
    async say(sayInput) {
      input.sayCalls?.push(sayInput)
      return { roomKey: sayInput.ref, groupId: 'EN-00006', envelopes: [] }
    },
  }
}

describe('mobile collaboration ledger', () => {
  test('room-key messages query is ledger-only because HRC rows have no room identity', async () => {
    const collaboration = ledger({
      messages: [ledgerMessage({ legacyMessageId: 'msg-legacy' })],
    })
    let hrcListCalls = 0
    const hrcClient = {
      async listMessages() {
        hrcListCalls += 1
        return { messages: [hrcMessage()] }
      },
    } as unknown as AcpHrcClient

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: '/v1/mobile/messages/query',
          body: { roomKey: 'T-07614', limit: 20, order: 'desc' },
        })
        const payload = await fixture.json<{ messages: CollaborationMessage[] }>(response)

        expect(response.status).toBe(200)
        expect(hrcListCalls).toBe(0)
        expect(payload.messages).toEqual([
          expect.objectContaining({
            messageId: 'EN-00005',
            roomKey: 'T-07614',
            sender: { principalRef: 'agent:lance' },
          }),
        ])
      },
      { hrcClient, collaborationLedger: collaboration }
    )
  })

  test('human DM dual-writes through agent:lance while HRC remains live delivery', async () => {
    const principals: string[] = []
    const sayCalls: CollaborationSayInput[] = []
    const humanLedger = ledger({ sayCalls })
    const semanticCalls: unknown[] = []
    const requestMessage = hrcMessage('msg-delivered')
    const hrcClient = {
      async semanticDm(input: unknown) {
        semanticCalls.push(input)
        return { request: requestMessage }
      },
    } as unknown as AcpHrcClient

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: '/v1/mobile/messages/dm',
          body: {
            body: 'Please reply in the room.',
            roomKey: 'T-07614',
            to: { kind: 'session', sessionRef: SESSION_REF },
          },
        })

        expect(response.status).toBe(200)
        expect(semanticCalls).toHaveLength(1)
        expect(principals).toEqual(['agent:lance'])
        expect(sayCalls).toEqual([
          {
            ref: 'T-07614',
            to: [MEMBER_REF],
            body: 'Please reply in the room.',
            idempotencyKey: 'acp:hrc-message:msg-delivered',
          },
        ])
      },
      {
        hrcClient,
        collaborationLedgerForPrincipal: async (principalRef) => {
          principals.push(principalRef)
          return humanLedger
        },
      }
    )
  })
})
