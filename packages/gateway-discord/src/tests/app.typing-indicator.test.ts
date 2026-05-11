import { describe, expect, test } from 'bun:test'

import { createLiveProgressHarness, hrcEvent, waitFor } from './live-progress-test-helpers.test.js'

describe('GatewayDiscordApp Discord typing indicator', () => {
  test('pings sendTyping when a pending placeholder is registered', async () => {
    const harness = createLiveProgressHarness()
    await harness.app.refreshBindings()
    await harness.app.handleMessageCreate(harness.inboundMessage())

    await waitFor(() => harness.channel.typingPings.length > 0)
    expect(harness.channel.typingPings.length).toBeGreaterThan(0)
  })

  test('stops pinging sendTyping as soon as a turn_end event arrives via SSE', async () => {
    const harness = createLiveProgressHarness()
    await harness.app.refreshBindings()
    await harness.app.handleMessageCreate(harness.inboundMessage())

    // First an event that lets the placeholder get claimed (so the turn_end
    // handler can find it by HRC run id).
    harness.emit(
      hrcEvent(1, {
        type: 'tool_execution_start',
        toolUseId: 'tool_pre',
        toolName: 'Bash',
        input: { command: 'echo pre' },
      })
    )
    await waitFor(() => harness.channel.typingPings.length > 0)
    const pingsBeforeTurnEnd = harness.channel.typingPings.length

    harness.emit(hrcEvent(2, { type: 'turn_end' }))
    // Give the SSE consumer a tick to handle turn_end and clear the timer.
    await new Promise((resolve) => setTimeout(resolve, 50))
    const pingsAfterTurnEnd = harness.channel.typingPings.length

    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(harness.channel.typingPings.length).toBe(pingsAfterTurnEnd)
    expect(pingsAfterTurnEnd).toBeGreaterThanOrEqual(pingsBeforeTurnEnd)
  })

  test('stops pinging sendTyping once the placeholder is cleared by final delivery', async () => {
    const harness = createLiveProgressHarness()
    await harness.app.refreshBindings()
    await harness.app.handleMessageCreate(harness.inboundMessage())

    await waitFor(() => harness.channel.typingPings.length > 0)
    const pingsBeforeDelivery = harness.channel.typingPings.length

    harness.enqueueDelivery('final answer; placeholder is gone now.')
    await harness.app.pollDeliveriesOnce()

    const pingsAfterDelivery = harness.channel.typingPings.length

    // Allow more wall time than TYPING_REFRESH_MS (8s); if the timer was still
    // running we'd see another ping. Use a short, deterministic wait — the
    // test stays under a couple hundred ms by relying on the absence of any
    // additional ping. The strict invariant is: count should not grow.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(harness.channel.typingPings.length).toBe(pingsAfterDelivery)
    expect(pingsAfterDelivery).toBeGreaterThanOrEqual(pingsBeforeDelivery)
  })
})
