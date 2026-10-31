import { describe, expect, test } from 'bun:test'

import type { WorkClient } from '@wrkq/client'
import { openInterfaceStore } from 'acp-interface-store'

import { createLiveProgressHarness, waitFor } from './live-progress-test-helpers.test.js'

/*
 * T-12177: ❌ on a ledger-routed placeholder. Ways it fails, pinned below:
 *  - the reaction is recorded as deferred forever (the original defect)
 *  - the gateway calls the ACP-run cancel route for a ledger input
 *  - the cancel names the wrong envelope or room
 *  - a ❌ before ingress returns is dropped
 *  - an outcome (or a failed call) leaves the placeholder unchanged: silent
 *  - a second ❌ cancels twice
 */

const LEDGER_STATE = {
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
}

function reaction(messageId: string) {
  return { partial: false, emoji: { name: 'X' }, message: { id: messageId } } as never
}

function user(id = 'user_cancel') {
  return { id, bot: false, partial: false } as never
}

function ledgerHarness(
  options: {
    ledgerCancelResponse?: (envelopeId: string) => Response | Promise<Response>
    beforeInterfaceMessageResponse?: () => Promise<void>
  } = {}
) {
  return createLiveProgressHarness({
    interfaceMessageResponse: () => LEDGER_STATE,
    ledgerHumanEgress: {
      client: {} as unknown as WorkClient,
      store: openInterfaceStore({ dbPath: ':memory:' }),
    },
    ...options,
  })
}

async function sendAndReact(harness: ReturnType<typeof ledgerHarness>) {
  await harness.app.refreshBindings()
  await harness.app.handleMessageCreate(harness.inboundMessage())
  const messageId = harness.webhook().sent[0]!.message.id
  await harness.app.handleMessageReactionAdd(reaction(messageId), user())
  return messageId
}

const lastEdit = (harness: ReturnType<typeof ledgerHarness>) =>
  String(harness.webhook().edits.at(-1)?.payload.content ?? '')

describe('GatewayDiscordApp ❌ on a ledger-routed placeholder', () => {
  test('cancels the ledger input envelope and shows Cancelled', async () => {
    const harness = ledgerHarness()
    const messageId = await sendAndReact(harness)

    expect(harness.cancelledRunIds).toEqual([])
    expect(harness.ledgerCancels).toEqual([
      {
        envelopeId: 'EN-00041',
        body: {
          gatewayId: 'discord_prod',
          roomUuid: 'room_ledger_1',
          actorRef: 'discord:user:user_cancel',
        },
      },
    ])
    expect(lastEdit(harness)).toContain('🛑 **Cancelled:**')

    // Retired: a second ❌ does nothing more.
    await harness.app.handleMessageReactionAdd(reaction(messageId), user())
    expect(harness.ledgerCancels).toHaveLength(1)
  })

  test('withdrawn shows Cancelled (withdrawn before presentation)', async () => {
    const harness = ledgerHarness({
      ledgerCancelResponse: () => Response.json({ outcome: 'withdrawn' }),
    })
    await sendAndReact(harness)
    expect(lastEdit(harness)).toContain('🛑 **Cancelled (withdrawn before presentation):**')
  })

  test('not_applied shows the reason, never silent', async () => {
    const harness = ledgerHarness({
      ledgerCancelResponse: () =>
        Response.json({ outcome: 'not_applied', reason: 'runtime_unavailable: svc down' }),
    })
    await sendAndReact(harness)
    expect(lastEdit(harness)).toContain('⚠️ **Cancel not applied:** runtime_unavailable: svc down')
  })

  test('a failing cancel route shows Cancel not applied', async () => {
    const harness = ledgerHarness({
      ledgerCancelResponse: () => new Response('boom', { status: 500 }),
    })
    await sendAndReact(harness)
    expect(lastEdit(harness)).toContain('⚠️ **Cancel not applied:**')
  })

  test('❌ before ingress returns is applied once the ledger route is known', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const harness = ledgerHarness({ beforeInterfaceMessageResponse: () => gate })
    await harness.app.refreshBindings()
    const pending = harness.app.handleMessageCreate(harness.inboundMessage())
    await waitFor(() => [...harness.channel.webhooks.values()].some((w) => w.sent.length > 0))
    await harness.app.handleMessageReactionAdd(
      reaction(harness.webhook().sent[0]!.message.id),
      user()
    )
    expect(harness.ledgerCancels).toEqual([])

    release?.()
    await pending
    await waitFor(() => harness.ledgerCancels.length === 1)
    expect(harness.ledgerCancels[0]?.envelopeId).toBe('EN-00041')
    await waitFor(() => lastEdit(harness).includes('🛑 **Cancelled:**'))
  })
})
