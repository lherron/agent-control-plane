import { describe, expect, test } from 'bun:test'

import {
  createLiveProgressHarness,
  toolEnd,
  toolStart,
  waitFor,
} from './live-progress-test-helpers.test.js'

describe('GatewayDiscordApp live progress final budget', () => {
  test('keeps compact history plus the complete final answer within one Discord edit', async () => {
    const harness = createLiveProgressHarness()
    await harness.app.refreshBindings()
    await harness.app.handleMessageCreate(harness.inboundMessage())
    const webhook = harness.webhook()

    for (let index = 0; index < 20; index += 1) {
      const seq = index * 2 + 1
      harness.emit(
        toolStart(seq, `tool_${index}`, 'Read', {
          file_path: `packages/gateway-discord/src/fixture-${String(index).padStart(2, '0')}.ts`,
        })
      )
      harness.emit(toolEnd(seq + 1, `tool_${index}`, 'Read'))
    }
    await waitFor(() => webhook.edits.length > 0)
    const progressEditCount = webhook.edits.length

    const finalAnswer = `Final answer begins. ${'This answer must remain intact after compacting the tool history. '.repeat(18)}Final answer ends.`
    harness.enqueueDelivery(finalAnswer)
    await harness.app.pollDeliveriesOnce()

    expect(webhook.edits.length).toBe(progressEditCount + 1)
    expect(webhook.sent).toHaveLength(1)
    const content = webhook.edits.at(-1)?.payload.content ?? ''
    expect(content.length).toBeLessThanOrEqual(1900)
    expect(content).toContain('_... +8 earlier tools_')
    expect(content).toContain('📖 Read: "packages/gateway-discord/src/fixture-19.ts"')
    expect(content).toContain(finalAnswer)
    expect(content).toContain('Final answer ends.')

    const toolLines = content.split('\n').filter((line) => line.includes('📖 Read:'))
    expect(toolLines).toHaveLength(12)
  })
})
