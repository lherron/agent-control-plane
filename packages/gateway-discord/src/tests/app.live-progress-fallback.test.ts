import { describe, expect, test } from 'bun:test'

import {
  createLiveProgressHarness,
  createRateLimitError,
  toolStart,
  waitFor,
} from './live-progress-test-helpers.test.js'

describe('GatewayDiscordApp live progress edit failure fallback', () => {
  test('disables progress edits after a 429 and still renders final delivery', async () => {
    const harness = createLiveProgressHarness()
    await harness.app.refreshBindings()
    await harness.app.handleMessageCreate(harness.inboundMessage())
    const webhook = harness.webhook()

    webhook.failNextEditWith = createRateLimitError()
    harness.emit(toolStart(1, 'tool_1', 'Bash', { command: 'bun test --filter live-progress' }))
    await waitFor(() => webhook.failedEdits.length > 0)

    expect(webhook.failedEdits).toHaveLength(1)
    expect(webhook.failedEdits[0]?.payload.content).toContain('💻 shell')

    harness.emit(
      toolStart(2, 'tool_2', 'Read', { file_path: 'packages/gateway-discord/src/app.ts' })
    )
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(webhook.failedEdits).toHaveLength(1)
    expect(webhook.edits).toHaveLength(0)

    harness.enqueueDelivery('Final answer after progress edit failure.')
    await harness.app.pollDeliveriesOnce()

    expect(webhook.edits).toHaveLength(1)
    expect(webhook.edits[0]?.payload.content).toContain('Final answer after progress edit failure.')
  })
})
