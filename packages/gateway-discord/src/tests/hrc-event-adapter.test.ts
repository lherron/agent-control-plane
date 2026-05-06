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

  test('drops events without runId', () => {
    expect(adaptHrcLifecycleEvent(hrcEvent({ runId: undefined }))).toBeUndefined()
    expect(adaptHrcLifecycleEvent(hrcEvent({ runId: '' }))).toBeUndefined()
  })
})
