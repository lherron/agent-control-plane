import { describe, expect, test } from 'bun:test'
import type { UnifiedSessionEvent } from 'spaces-runtime'

import { toCompletedVisibleAssistantMessage } from '../src/delivery/visible-assistant-messages.js'

describe('toCompletedVisibleAssistantMessage launch exit outcomes', () => {
  test('preserves synthesized launch signal metadata as a visible degraded outcome', () => {
    const message = toCompletedVisibleAssistantMessage({
      type: 'turn_end',
      payload: {
        type: 'turn.completed',
        source: 'launch_exit_synthesized',
        success: false,
        outcome: {
          state: 'degraded',
          reason: 'launch_signalled',
          source: 'launch_exit_synthesized',
          signal: 'SIGTERM',
        },
      },
    } as unknown as UnifiedSessionEvent)

    expect(message).toEqual({
      text: '',
      outcome: {
        state: 'degraded',
        reason: 'launch_signalled',
        source: 'launch_exit_synthesized',
        signal: 'SIGTERM',
      },
    })
  })

  test('preserves synthesized launch failure metadata as a visible degraded outcome', () => {
    const message = toCompletedVisibleAssistantMessage({
      type: 'turn_end',
      payload: {
        type: 'turn.completed',
        source: 'launch_exit_synthesized',
        success: false,
        outcome: {
          state: 'degraded',
          reason: 'launch_failed',
          source: 'launch_exit_synthesized',
          exitCode: 42,
        },
      },
    } as unknown as UnifiedSessionEvent)

    expect(message).toEqual({
      text: '',
      outcome: {
        state: 'degraded',
        reason: 'launch_failed',
        source: 'launch_exit_synthesized',
        exitCode: 42,
      },
    })
  })
})
