import { describe, expect, test } from 'bun:test'

import { createLiveProgressHarness, toolStart, waitFor } from './live-progress-test-helpers.test.js'

describe('GatewayDiscordApp live progress throttle', () => {
  test('coalesces rapid tool events and flushes the last state after the quiet window', async () => {
    const harness = createLiveProgressHarness()
    await harness.app.refreshBindings()
    await harness.app.handleMessageCreate(harness.inboundMessage())
    const webhook = harness.webhook()

    const startedAt = Date.now()
    for (let index = 0; index < 10; index += 1) {
      harness.emit(
        toolStart(index + 1, `tool_${index}`, 'Bash', {
          command: `printf ${index}`,
        })
      )
    }

    await new Promise((resolve) => setTimeout(resolve, 100))
    const elapsed = Date.now() - startedAt
    const maxAllowedEarlyEdits = Math.ceil(elapsed / 1500) + 1
    expect(webhook.edits.length).toBeLessThanOrEqual(maxAllowedEarlyEdits)

    const earlyEditCount = webhook.edits.length
    await waitFor(
      () =>
        webhook.edits.length > earlyEditCount &&
        (webhook.edits.at(-1)?.payload.content ?? '').includes('printf 9'),
      1800
    )

    expect(webhook.edits.length).toBeGreaterThan(earlyEditCount)
    expect(webhook.edits.at(-1)?.payload.content).toContain('printf 9')
  })
})
