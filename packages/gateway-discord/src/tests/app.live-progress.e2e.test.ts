import { describe, expect, test } from 'bun:test'

import {
  createLiveProgressHarness,
  toolEnd,
  toolStart,
  waitFor,
} from './live-progress-test-helpers.test.js'

describe('GatewayDiscordApp live tool progress e2e', () => {
  test('edits the placeholder with compact hermes-style tool progress', async () => {
    const harness = createLiveProgressHarness()
    await harness.app.refreshBindings()
    await harness.app.handleMessageCreate(harness.inboundMessage())

    const webhook = harness.webhook()
    expect(webhook.sent).toHaveLength(1)
    expect(webhook.sent[0]?.content).toContain('⏳ **Processing:**')

    harness.emit(toolStart(1, 'tool_1', 'Bash', { command: 'bun test' }))
    harness.emit(toolEnd(2, 'tool_1', 'Bash'))
    harness.emit(toolStart(3, 'tool_2', 'Bash', { command: 'bun test' }))
    harness.emit(toolEnd(4, 'tool_2', 'Bash'))
    harness.emit(
      toolStart(5, 'tool_3', 'Read', { file_path: 'packages/gateway-discord/src/app.ts' })
    )
    harness.emit(toolEnd(6, 'tool_3', 'Read'))

    await waitFor(() => webhook.edits.length > 0)

    expect(harness.eventRequests).toHaveLength(1)
    expect(harness.eventRequests[0]?.searchParams.get('follow')).toBe('true')
    expect(harness.eventRequests[0]?.searchParams.get('fromSeq')).toBe('1')
    expect(harness.eventRequests[0]?.searchParams.get('sessionRef')).toBe(
      'agent:smokey:project:agent-spaces/lane:main'
    )
    expect(harness.eventRequests[0]?.searchParams.has('runId')).toBe(false)

    const content = webhook.edits.at(-1)?.payload.content ?? ''
    expect(content).toContain('💻 shell: "bun test"')
    expect(content).toContain('(×2)')
    expect(content).toContain('📖 Read: "packages/gateway-discord/src/app.ts"')
    expect(content).not.toContain('✅ **Bash**')
    expect(content).not.toContain('```')

    const toolLineIcons = ['💻', '📖', '✍️', '🔧', '🔎', '📁', '🤖', '📄', '🔍', '📋', '📓', '⚙️']
    const toolLines = content
      .split('\n')
      .filter((line) => toolLineIcons.some((icon) => line.includes(icon)))
    expect(toolLines.length).toBeLessThanOrEqual(12)
    for (const line of toolLines) {
      expect(line.length).toBeLessThanOrEqual(80)
    }
  })
})
