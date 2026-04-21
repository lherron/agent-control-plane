import { randomUUID } from 'node:crypto'

import type { LaunchRoleScopedRun } from './deps.js'

export function createEchoLauncher(): LaunchRoleScopedRun {
  return async ({ intent, onEvent }) => {
    const runId = `echo-run-${randomUUID().slice(0, 8)}`
    const sessionId = `echo-session-${randomUUID().slice(0, 8)}`
    const prompt =
      typeof intent.initialPrompt === 'string' && intent.initialPrompt.length > 0
        ? intent.initialPrompt
        : '(empty)'

    queueMicrotask(async () => {
      try {
        await onEvent?.({
          type: 'message_end',
          messageId: `echo-msg-${randomUUID().slice(0, 8)}`,
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: `echo launcher reply: ${prompt}` }],
          },
        })
      } catch {
        // swallow — dev-only smoke path
      }
    })

    return { runId, sessionId }
  }
}
