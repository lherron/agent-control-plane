import { describe, expect, test } from 'bun:test'

import { createLiveProgressHarness, waitFor } from './live-progress-test-helpers.test.js'

function reaction(input: { messageId: string; name: string }) {
  return {
    partial: false,
    emoji: { name: input.name },
    message: { id: input.messageId },
  } as never
}

function user(input: { id?: string | undefined; bot?: boolean | undefined } = {}) {
  return {
    id: input.id ?? 'user_cancel',
    bot: input.bot ?? false,
    partial: false,
  } as never
}

describe('GatewayDiscordApp reaction cancellation', () => {
  test('X reaction on an active agent placeholder cancels the correlated ACP run', async () => {
    const harness = createLiveProgressHarness()

    await harness.app.refreshBindings()
    await harness.app.handleMessageCreate(harness.inboundMessage())

    const sent = harness.webhook().sent[0]
    expect(sent).toBeDefined()

    await harness.app.handleMessageReactionAdd(
      reaction({ messageId: sent!.message.id, name: 'X' }),
      user()
    )

    expect(harness.cancelledRunIds).toEqual(['run_live_progress'])
    expect(harness.webhook().edits.at(-1)?.payload.content).toContain('Cancel requested')
  })

  test('Cancel reaction names are accepted and non-virtu bot reactions are ignored', async () => {
    const harness = createLiveProgressHarness()

    await harness.app.refreshBindings()
    await harness.app.handleMessageCreate(harness.inboundMessage())

    const messageId = harness.webhook().sent[0]!.message.id

    await harness.app.handleMessageReactionAdd(reaction({ messageId, name: 'Cancel' }), user())
    await harness.app.handleMessageReactionAdd(
      reaction({ messageId, name: 'X' }),
      user({ bot: true })
    )

    expect(harness.cancelledRunIds).toEqual(['run_live_progress'])
  })

  test('virtu bot reactions are accepted for real Discord smoke coverage', async () => {
    const harness = createLiveProgressHarness()

    await harness.app.refreshBindings()
    await harness.app.handleMessageCreate(harness.inboundMessage())

    const messageId = harness.webhook().sent[0]!.message.id

    await harness.app.handleMessageReactionAdd(
      reaction({ messageId, name: 'X' }),
      user({ id: '1165644636807778414', bot: true })
    )

    expect(harness.cancelledRunIds).toEqual(['run_live_progress'])
  })

  test('reaction before ACP returns the run id cancels once the run is known', async () => {
    let releaseIngress: (() => void) | undefined
    const ingressGate = new Promise<void>((resolve) => {
      releaseIngress = resolve
    })
    const harness = createLiveProgressHarness({
      beforeInterfaceMessageResponse: () => ingressGate,
    })

    await harness.app.refreshBindings()
    const messagePromise = harness.app.handleMessageCreate(harness.inboundMessage())
    await waitFor(() => [...harness.channel.webhooks.values()].some((item) => item.sent.length > 0))

    const messageId = harness.webhook().sent[0]!.message.id
    await harness.app.handleMessageReactionAdd(reaction({ messageId, name: 'X' }), user())
    expect(harness.cancelledRunIds).toEqual([])

    releaseIngress?.()
    await messagePromise
    await waitFor(() => harness.cancelledRunIds.length === 1)

    expect(harness.cancelledRunIds).toEqual(['run_live_progress'])
  })
})
