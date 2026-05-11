import { describe, expect, test } from 'bun:test'

import type { HrcEvent } from '../hrc-store-reader.js'
import { hrcEventToTimelineRow } from '../output/hrc-event-to-row.js'

function event(overrides: Partial<HrcEvent>): HrcEvent {
  return {
    hrcSeq: 1,
    ts: '2026-05-11T05:31:34.000Z',
    scopeRef: 'cody@agent-spaces:T-TIMELINE',
    laneRef: 'main',
    runId: 'hrc-run-1',
    eventKind: 'tool_execution_start',
    eventJson: {},
    ...overrides,
  }
}

function rowFor(input: HrcEvent) {
  return hrcEventToTimelineRow({
    event: input,
    parentParticipantRunId: 'prun_1',
    joinKind: 'run_id',
    detail: 'events',
  })
}

describe('hrc event timeline rows', () => {
  test('formats tool starts with shared Discord-style tool rendering', () => {
    const row = rowFor(
      event({
        eventJson: { toolName: 'exec_command', input: { cmd: 'ls -la /tmp' } },
      })
    )

    expect(row).toMatchObject({
      displayText: '💻 exec_command: "ls -la /tmp"',
      toolName: 'exec_command',
      payload: { toolName: 'exec_command', input: { cmd: 'ls -la /tmp' } },
    })
  })

  test('formats tool endings with exit metadata', () => {
    const row = rowFor(
      event({
        eventKind: 'tool_execution_end',
        eventJson: {
          toolName: 'exec_command',
          result: { metadata: { exit_code: 0 } },
        },
      })
    )

    expect(row.displayText).toBe('💻 exec_command: exit=0')
    expect(row.toolName).toBe('exec_command')
  })

  test('formats codex tool_execution_end result content instead of leaving empty apply_patch rows', () => {
    const row = rowFor(
      event({
        eventKind: 'tool_execution_end',
        eventJson: {
          toolName: 'apply_patch',
          result: {
            content: [
              {
                type: 'text',
                text: '{"output":"Success. Updated the following files:\\nM packages/acp-cli/src/cli.ts\\n","metadata":{"exit_code":0,"duration_seconds":0}}',
              },
            ],
          },
          isError: false,
        },
      })
    )

    expect(row.displayText).toBe('🔧 apply_patch: exit=0')
    expect(row.toolName).toBe('apply_patch')
  })

  test('keeps assistant response bodies for renderer markdown blocks', () => {
    const row = rowFor(
      event({
        eventKind: 'message_end',
        eventJson: { message: { content: '## Done\n- item' } },
      })
    )

    expect(row).toMatchObject({
      eventKind: 'message_end',
      displayText: '🤖 assistant',
      assistantBody: '## Done\n- item',
      payload: { message: { content: '## Done\n- item' } },
    })
  })

  test('formats codex user prompts from top-level prompt payloads', () => {
    const row = rowFor(
      event({
        eventKind: 'codex.user_prompt',
        eventJson: {
          type: 'codex.user_prompt',
          prompt: 'You are starting an ACP workflow participant run.',
        },
      })
    )

    expect(row).toMatchObject({
      displayText: '💬 codex.user_prompt  "You are starting an ACP workflow participant run."',
      label: 'You are starting an ACP workflow participant run.',
    })
  })

  test('formats turn user prompts from nested message content payloads', () => {
    const row = rowFor(
      event({
        eventKind: 'turn.user_prompt',
        eventJson: {
          type: 'message_end',
          message: {
            role: 'user',
            content: 'Use the context below as the authoritative task contract.',
          },
        },
      })
    )

    expect(row).toMatchObject({
      displayText:
        '💬 turn.user_prompt  "Use the context below as the authoritative task contract."',
      label: 'Use the context below as the authoritative task contract.',
    })
  })
})
