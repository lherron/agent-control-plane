import { describe, expect, test } from 'bun:test'
import type { WrkqEnvelope } from '@wrkq/client'

import { resolveEnvelopeSinks } from '../ledger-human-egress.js'

const route = {
  gatewayId: 'discord_prod',
  roomUuid: 'room_note',
  roomKey: 'R-00010',
  bindingId: 'ifb_note',
  conversationRef: 'channel:chan_note',
  humanPrincipalRef: 'agent:lance',
}

function toLance(obligation: string): WrkqEnvelope {
  return {
    uuid: `uuid-${obligation}`,
    id: 'EN-00090',
    roomUuid: route.roomUuid,
    roomKey: route.roomKey,
    groupId: 'EN-00090',
    from: { principalRef: 'agent:cody', scopeRef: 'cody@agent-spaces:primary' },
    to: { principalRef: 'agent:lance' },
    replyTo: 'cody@agent-spaces:primary',
    obligation,
    body: 'body',
    state: 'pending',
    terminal: false,
    meta: {},
    presentedTo: [],
    etag: 1,
    createdAt: '2026-10-26T00:00:00Z',
    updatedAt: '2026-10-26T00:00:00Z',
  } as unknown as WrkqEnvelope
}

describe('resolveEnvelopeSinks', () => {
  test('a note to the human is mirrored but never presented as a human notice', () => {
    const sinks = resolveEnvelopeSinks(toLance('note'), {
      controlPlaneChannelId: 'chan_mirror',
      route,
    })
    expect(sinks.map((sink) => sink.kind)).toEqual(['mirror'])
  })

  test('fyi and reply_required to the human still get a human notice', () => {
    for (const obligation of ['fyi', 'reply_required']) {
      const sinks = resolveEnvelopeSinks(toLance(obligation), { route })
      expect(sinks.map((sink) => sink.kind)).toEqual(['human-notice'])
    }
  })
})
