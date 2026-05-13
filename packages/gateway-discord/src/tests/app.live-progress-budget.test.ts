import { describe, expect, test } from 'bun:test'

import {
  createLiveProgressHarness,
  hrcEvent,
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
    expect(content.length).toBeLessThanOrEqual(2000)
    expect(content).toContain('_... +8 earlier tools_')
    expect(content).toContain('📖 Read: packages/gateway-discord/src/fixture-19.ts')
    expect(content).toContain(finalAnswer)
    expect(content).toContain('Final answer ends.')

    const toolLines = content.split('\n').filter((line) => line.includes('📖 Read:'))
    expect(toolLines).toHaveLength(12)
  })

  test('keeps assistant segments before and after tools in final placeholder edit', async () => {
    const harness = createLiveProgressHarness()
    await harness.app.refreshBindings()
    await harness.app.handleMessageCreate(harness.inboundMessage())
    const webhook = harness.webhook()

    harness.emit(
      hrcEvent(1, {
        type: 'message_start',
        messageId: 'msg-before',
        message: { role: 'assistant', content: '' },
      })
    )
    harness.emit(
      hrcEvent(2, {
        type: 'message_update',
        messageId: 'msg-before',
        textDelta: 'BEFORE-LIVE',
      })
    )
    harness.emit(
      hrcEvent(3, {
        type: 'message_end',
        messageId: 'msg-before',
        message: { role: 'assistant', content: 'BEFORE-LIVE' },
      })
    )
    harness.emit(toolStart(4, 'tool_live', 'command_execution', { command: 'sleep 20' }))
    harness.emit(toolEnd(5, 'tool_live', 'command_execution'))
    harness.emit(
      hrcEvent(6, {
        type: 'message_start',
        messageId: 'msg-after',
        message: { role: 'assistant', content: '' },
      })
    )
    harness.emit(
      hrcEvent(7, {
        type: 'message_update',
        messageId: 'msg-after',
        textDelta: 'AFTER-LIVE',
      })
    )
    harness.emit(
      hrcEvent(8, {
        type: 'message_end',
        messageId: 'msg-after',
        message: { role: 'assistant', content: 'AFTER-LIVE' },
      })
    )

    await waitFor(() => webhook.edits.length > 0)
    harness.enqueueDelivery('AFTER-LIVE')
    await harness.app.pollDeliveriesOnce()

    const content = webhook.edits.at(-1)?.payload.content ?? ''
    const beforeIndex = content.indexOf('BEFORE-LIVE')
    const toolIndex = content.indexOf('command_execution')
    const afterIndex = content.indexOf('AFTER-LIVE')
    expect(beforeIndex).toBeGreaterThanOrEqual(0)
    expect(toolIndex).toBeGreaterThan(beforeIndex)
    expect(afterIndex).toBeGreaterThan(toolIndex)
    expect(content.match(/AFTER-LIVE/g)).toHaveLength(1)
  })

  test('renders shell display label for wrapped command_execution in live progress edit', async () => {
    const harness = createLiveProgressHarness()
    await harness.app.refreshBindings()
    await harness.app.handleMessageCreate(harness.inboundMessage())
    const webhook = harness.webhook()

    harness.emit(
      toolStart(1, 'tool_shell', 'command_execution', { command: "/bin/zsh -lc 'printf X'" })
    )
    harness.emit(toolEnd(2, 'tool_shell', 'command_execution'))

    await waitFor(() => webhook.edits.length > 0)

    const content = webhook.edits.at(-1)?.payload.content ?? ''
    expect(content).toContain('shell: printf X')
    expect(content).not.toContain('command_execution: /bin/zsh -lc')
  })
})
