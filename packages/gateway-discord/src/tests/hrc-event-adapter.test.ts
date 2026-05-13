import { describe, expect, test } from 'bun:test'

import { type HrcLifecycleEventPayload, adaptHrcLifecycleEvent } from '../hrc-event-adapter.js'

function hrcEvent(overrides: Partial<HrcLifecycleEventPayload> = {}): HrcLifecycleEventPayload {
  return {
    hrcSeq: 41,
    eventKind: 'turn.message',
    scopeRef: 'agent:larry:project:agent-spaces:task:T-01372',
    runId: 'hrc-run-ignored',
    payload: {
      type: 'message_end',
      message: { role: 'assistant', content: 'hello from hrc' },
    },
    ...overrides,
  }
}

describe('adaptHrcLifecycleEvent', () => {
  test('maps turn.tool_call to tool_execution_start envelope with hrcSeq', () => {
    expect(
      adaptHrcLifecycleEvent(
        hrcEvent({
          hrcSeq: 7,
          eventKind: 'turn.tool_call',
          payload: {
            type: 'tool_execution_start',
            toolUseId: 'toolu_1',
            toolName: 'Bash',
            input: { command: 'bun test' },
          },
        })
      )
    ).toEqual({
      projectId: 'agent-spaces',
      runId: 'hrc-run-ignored',
      seq: 7,
      event: {
        type: 'tool_execution_start',
        toolUseId: 'toolu_1',
        toolName: 'Bash',
        input: { command: 'bun test' },
      },
    })
  })

  test('maps turn.tool_result to tool_execution_end envelope', () => {
    expect(
      adaptHrcLifecycleEvent(
        hrcEvent({
          eventKind: 'turn.tool_result',
          payload: {
            type: 'tool_execution_end',
            toolUseId: 'toolu_1',
            toolName: 'Bash',
            result: { content: [{ type: 'text', text: 'ok' }] },
            isError: false,
          },
        })
      )?.event
    ).toEqual({
      type: 'tool_execution_end',
      toolUseId: 'toolu_1',
      toolName: 'Bash',
      result: { content: [{ type: 'text', text: 'ok' }] },
      isError: false,
    })
  })

  test('maps assistant turn.message to message_end and drops non-assistant messages', () => {
    expect(adaptHrcLifecycleEvent(hrcEvent())?.event).toMatchObject({
      type: 'message_end',
      messageId: 'hrc:41',
      message: { role: 'assistant', content: 'hello from hrc' },
    })

    expect(
      adaptHrcLifecycleEvent(
        hrcEvent({
          payload: {
            type: 'message_end',
            message: { role: 'user', content: 'not for progress bubble' },
          },
        })
      )
    ).toBeUndefined()
  })

  test('synthesizes a unique messageId per turn.message so consecutive prose blocks each render', () => {
    const first = adaptHrcLifecycleEvent(
      hrcEvent({
        hrcSeq: 101,
        eventKind: 'turn.message',
        payload: {
          type: 'message_end',
          message: { role: 'assistant', content: 'first prose block' },
        },
      })
    )
    const second = adaptHrcLifecycleEvent(
      hrcEvent({
        hrcSeq: 103,
        eventKind: 'turn.message',
        payload: {
          type: 'message_end',
          message: { role: 'assistant', content: 'second prose block' },
        },
      })
    )

    expect(first?.event).toMatchObject({
      type: 'message_end',
      messageId: 'hrc:101',
      message: { role: 'assistant', content: 'first prose block' },
    })
    expect(second?.event).toMatchObject({
      type: 'message_end',
      messageId: 'hrc:103',
      message: { role: 'assistant', content: 'second prose block' },
    })
    // distinct ids let SessionEventsManager push two separate segments instead
    // of dropping the second one through the no-targetRef close-only branch.
    expect((first?.event as { messageId?: string }).messageId).not.toBe(
      (second?.event as { messageId?: string }).messageId
    )
  })

  test('preserves payload messageId on turn.message when present (does not override with fallback)', () => {
    const envelope = adaptHrcLifecycleEvent(
      hrcEvent({
        hrcSeq: 200,
        eventKind: 'turn.message',
        payload: {
          type: 'message_end',
          messageId: 'msg-from-payload',
          message: { role: 'assistant', content: 'hello' },
        },
      })
    )
    expect(envelope?.event).toMatchObject({
      type: 'message_end',
      messageId: 'msg-from-payload',
    })
  })

  test('raw message_end with no payload id stays anchorless (streaming dedup preserved)', () => {
    const envelope = adaptHrcLifecycleEvent(
      hrcEvent({
        hrcSeq: 300,
        eventKind: 'message_end',
        payload: {
          type: 'message_end',
          message: { role: 'assistant', content: 'cumulative streamed text' },
        },
      })
    )
    expect(envelope?.event).toMatchObject({
      type: 'message_end',
      message: { role: 'assistant', content: 'cumulative streamed text' },
    })
    expect((envelope?.event as { messageId?: string }).messageId).toBeUndefined()
  })

  test('passes raw app-server assistant streaming events through', () => {
    expect(
      adaptHrcLifecycleEvent(
        hrcEvent({
          hrcSeq: 11,
          eventKind: 'message_start',
          payload: {
            type: 'message_start',
            messageId: 'msg-1',
            message: { role: 'assistant', content: '' },
          },
        })
      )
    ).toEqual({
      projectId: 'agent-spaces',
      runId: 'hrc-run-ignored',
      seq: 11,
      event: {
        type: 'message_start',
        messageId: 'msg-1',
        message: { role: 'assistant', content: '' },
      },
    })

    expect(
      adaptHrcLifecycleEvent(
        hrcEvent({
          hrcSeq: 12,
          eventKind: 'message_update',
          payload: {
            type: 'message_update',
            messageId: 'msg-1',
            textDelta: 'before tool',
          },
        })
      )?.event
    ).toEqual({
      type: 'message_update',
      messageId: 'msg-1',
      textDelta: 'before tool',
    })
  })

  test('maps turn.completed to turn_end with payload intact', () => {
    expect(
      adaptHrcLifecycleEvent(
        hrcEvent({
          eventKind: 'turn.completed',
          payload: { finalOutput: 'done' },
        })
      )?.event
    ).toEqual({
      type: 'turn_end',
      payload: { finalOutput: 'done' },
    })
  })

  test('passes notice-shaped payloads through and drops unknown event kinds', () => {
    expect(
      adaptHrcLifecycleEvent(
        hrcEvent({
          hrcSeq: 9,
          eventKind: 'notice',
          payload: { type: 'notice', level: 'warn', message: 'stream compacted' },
        })
      )
    ).toEqual({
      projectId: 'agent-spaces',
      runId: 'hrc-run-ignored',
      seq: 9,
      event: { type: 'notice', level: 'warn', message: 'stream compacted' },
    })

    expect(
      adaptHrcLifecycleEvent(
        hrcEvent({ eventKind: 'runtime.created', payload: { runtimeId: 'rt_1' } })
      )
    ).toBeUndefined()
  })

  test('renders accepted in-flight admission as contribution accepted without steered or applied', () => {
    const envelope = adaptHrcLifecycleEvent(
      hrcEvent({
        eventKind: 'input.application.accepted',
        payload: {
          admissionKind: 'accepted_in_flight',
          applicationStatus: 'accepted',
          ackSemantics: 'accepted_only',
        },
      })
    )

    expect(envelope?.event).toEqual({
      type: 'notice',
      level: 'info',
      message: 'Contribution accepted',
    })
    expect(JSON.stringify(envelope)).not.toMatch(/\bsteered\b/i)
    expect(JSON.stringify(envelope)).not.toMatch(/\bapplied\b/i)
  })

  test('drops events without runId', () => {
    expect(adaptHrcLifecycleEvent(hrcEvent({ runId: undefined }))).toBeUndefined()
    expect(adaptHrcLifecycleEvent(hrcEvent({ runId: '' }))).toBeUndefined()
  })
})
