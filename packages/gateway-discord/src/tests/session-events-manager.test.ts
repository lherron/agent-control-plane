import { describe, expect, test } from 'bun:test'

import { SessionEventsManager } from '../session-events-manager.js'

describe('SessionEventsManager internal run handling', () => {
  test('ignores explicitly internal events without keeping project-level internal run ids', () => {
    const renders: Array<{ projectId: string; runId: string }> = []

    const manager = new SessionEventsManager('gateway-test', (projectId, runId) => {
      renders.push({ projectId, runId })
    })

    manager.subscribe('control-plane')
    manager.receive({
      projectId: 'control-plane',
      seq: 1,
      runId: 'run-internal',
      run: { visibility: 'internal' },
      event: {
        type: 'run_queued',
        runId: 'run-internal',
        projectId: 'control-plane',
        queuedAt: 1,
        input: { content: 'hidden' },
      },
    })

    expect(manager.getRunState('control-plane', 'run-internal')).toBeUndefined()
    expect(renders).toHaveLength(0)

    manager.receive({
      projectId: 'control-plane',
      seq: 2,
      runId: 'run-internal',
      event: {
        type: 'run_started',
        runId: 'run-internal',
        projectId: 'control-plane',
        startedAt: 2,
      },
    })

    expect(manager.getRunState('control-plane', 'run-internal')).toBeDefined()
    expect(renders).toHaveLength(1)

    manager.receive({
      projectId: 'control-plane',
      seq: 3,
      runId: 'run-user',
      event: {
        type: 'run_queued',
        runId: 'run-user',
        projectId: 'control-plane',
        queuedAt: 3,
        input: { content: 'visible' },
      },
    })

    expect(manager.getRunState('control-plane', 'run-user')).toBeDefined()
    expect(renders).toHaveLength(2)
    expect(renders[1]?.runId).toBe('run-user')

    const projectState = (
      manager as unknown as {
        projects: Map<string, Record<string, unknown>>
      }
    ).projects.get('control-plane')
    expect(projectState).not.toHaveProperty('internalRunIds')
  })

  test('renders final assistant content carried on turn_end payload', () => {
    const renders: Array<{ projectId: string; runId: string; content: string }> = []

    const manager = new SessionEventsManager('gateway-test', (projectId, runId, frame) => {
      const markdown = frame.blocks.find((block) => block.t === 'markdown')
      renders.push({
        projectId,
        runId,
        content: markdown?.md ?? '',
      })
    })

    manager.subscribe('control-plane')
    manager.receive({
      projectId: 'control-plane',
      seq: 1,
      runId: 'run-user',
      event: {
        type: 'run_started',
        runId: 'run-user',
        projectId: 'control-plane',
        startedAt: 1,
      },
    })
    manager.receive({
      projectId: 'control-plane',
      seq: 2,
      runId: 'run-user',
      event: {
        type: 'turn_end',
        payload: {
          finalOutput: 'Final answer from turn.completed',
        },
      },
    })

    expect(manager.getRunState('control-plane', 'run-user')?.status).toBe('completed')
    expect(renders[renders.length - 1]).toEqual({
      projectId: 'control-plane',
      runId: 'run-user',
      content: 'Final answer from turn.completed',
    })
  })

  test('tracks event dedupe on RunState instead of ProjectState across resumed subscriptions', () => {
    const renders: Array<{ seq: number | undefined; content: string }> = []
    const manager = new SessionEventsManager('gateway-test', (_projectId, _runId, frame, run) => {
      const markdown = frame.blocks.find((block) => block.t === 'markdown')
      renders.push({
        seq: (run as unknown as { lastSeq?: number }).lastSeq,
        content: markdown?.md ?? '',
      })
    })

    manager.subscribe('agent-spaces')
    manager.receive({
      projectId: 'agent-spaces',
      runId: 'run-resumed',
      seq: 1,
      event: {
        type: 'run_started',
        runId: 'run-resumed',
        projectId: 'agent-spaces',
        startedAt: 1,
      },
    })

    manager.subscribe('agent-spaces')
    manager.receive({
      projectId: 'agent-spaces',
      runId: 'run-resumed',
      seq: 1,
      event: {
        type: 'message_update',
        textDelta: 'duplicate should not render',
      },
    })
    manager.receive({
      projectId: 'agent-spaces',
      runId: 'run-resumed',
      seq: 2,
      event: {
        type: 'message_update',
        textDelta: 'fresh update renders',
      },
    })

    expect(renders).toHaveLength(2)
    expect(renders.at(-1)).toEqual({ seq: 2, content: 'fresh update renders' })
    expect(
      manager.getRunState('agent-spaces', 'run-resumed') as unknown as { lastSeq?: number }
    ).toMatchObject({ lastSeq: 2 })

    const projectState = (
      manager as unknown as {
        projects: Map<string, Record<string, unknown>>
      }
    ).projects.get('agent-spaces')
    expect(projectState).toBeDefined()
    expect(projectState).not.toHaveProperty('lastSeq')
    expect(projectState).not.toHaveProperty('internalRunIds')
  })

  test('interleaves assistant segments between tool and notice blocks by arrival seq', () => {
    let lastFrame:
      | { blocks: Array<{ t: string; md?: string; toolName?: string; message?: string }> }
      | undefined
    const manager = new SessionEventsManager('gateway-test', (_pid, _rid, frame) => {
      lastFrame = frame as never
    })

    manager.subscribe('agent-spaces')
    manager.receive({
      projectId: 'agent-spaces',
      runId: 'run-mix',
      seq: 1,
      event: {
        type: 'run_started',
        runId: 'run-mix',
        projectId: 'agent-spaces',
        startedAt: 1,
      },
    })

    // text segment A
    manager.receive({
      projectId: 'agent-spaces',
      runId: 'run-mix',
      seq: 2,
      event: {
        type: 'message_start',
        messageId: 'msg-A',
        message: { role: 'assistant', content: '' },
      },
    })
    manager.receive({
      projectId: 'agent-spaces',
      runId: 'run-mix',
      seq: 3,
      event: { type: 'message_update', messageId: 'msg-A', textDelta: 'before-tool' },
    })

    // tool 1
    manager.receive({
      projectId: 'agent-spaces',
      runId: 'run-mix',
      seq: 4,
      event: {
        type: 'tool_execution_start',
        toolUseId: 'tu1',
        toolName: 'Read',
        input: { file_path: '/x' },
      },
    })
    manager.receive({
      projectId: 'agent-spaces',
      runId: 'run-mix',
      seq: 5,
      event: {
        type: 'tool_execution_end',
        toolUseId: 'tu1',
        toolName: 'Read',
        result: { content: [{ type: 'text', text: 'ok' }] },
      },
    })

    // notice
    manager.receive({
      projectId: 'agent-spaces',
      runId: 'run-mix',
      seq: 6,
      event: { type: 'notice', level: 'warn', message: 'heads up' },
    })

    // text segment B (after tool/notice — new messageId)
    manager.receive({
      projectId: 'agent-spaces',
      runId: 'run-mix',
      seq: 7,
      event: { type: 'message_update', messageId: 'msg-B', textDelta: 'after-tool' },
    })

    // tool 2
    manager.receive({
      projectId: 'agent-spaces',
      runId: 'run-mix',
      seq: 8,
      event: {
        type: 'tool_execution_start',
        toolUseId: 'tu2',
        toolName: 'Bash',
        input: { command: 'ls' },
      },
    })

    // text segment C
    manager.receive({
      projectId: 'agent-spaces',
      runId: 'run-mix',
      seq: 9,
      event: { type: 'message_update', messageId: 'msg-C', textDelta: 'final' },
    })
    manager.receive({
      projectId: 'agent-spaces',
      runId: 'run-mix',
      seq: 10,
      event: { type: 'message_end', messageId: 'msg-C' },
    })

    expect(lastFrame).toBeDefined()
    const order = lastFrame!.blocks.map((b) =>
      b.t === 'markdown'
        ? `text:${b.md}`
        : b.t === 'tool'
          ? `tool:${b.toolName}`
          : b.t === 'notice'
            ? `notice:${b.message}`
            : b.t
    )
    expect(order).toEqual([
      'text:before-tool',
      'tool:Read',
      'notice:heads up',
      'text:after-tool',
      'tool:Bash',
      'text:final',
    ])
  })

  test('no-messageId stream does not duplicate the segment after a tool boundary closes it', () => {
    let lastFrame: { blocks: Array<{ t: string; md?: string; toolName?: string }> } | undefined
    const manager = new SessionEventsManager('gateway-test', (_pid, _rid, frame) => {
      lastFrame = frame as never
    })

    manager.subscribe('agent-spaces')
    manager.receive({
      projectId: 'agent-spaces',
      runId: 'run-noid',
      seq: 1,
      event: {
        type: 'run_started',
        runId: 'run-noid',
        projectId: 'agent-spaces',
        startedAt: 1,
      },
    })

    // message_start with no messageId, no content
    manager.receive({
      projectId: 'agent-spaces',
      runId: 'run-noid',
      seq: 2,
      event: { type: 'message_start', message: { role: 'assistant', content: '' } },
    })

    // streaming delta, no messageId
    manager.receive({
      projectId: 'agent-spaces',
      runId: 'run-noid',
      seq: 3,
      event: { type: 'message_update', textDelta: 'before' },
    })

    // tool fires mid-message — closes active append, but the message itself isn't done
    manager.receive({
      projectId: 'agent-spaces',
      runId: 'run-noid',
      seq: 4,
      event: {
        type: 'tool_execution_start',
        toolUseId: 'tu1',
        toolName: 'Read',
        input: { file_path: '/x' },
      },
    })
    manager.receive({
      projectId: 'agent-spaces',
      runId: 'run-noid',
      seq: 5,
      event: {
        type: 'tool_execution_end',
        toolUseId: 'tu1',
        toolName: 'Read',
        result: { content: [{ type: 'text', text: 'ok' }] },
      },
    })

    // message_end carries the full final assistant message — STILL no messageId
    manager.receive({
      projectId: 'agent-spaces',
      runId: 'run-noid',
      seq: 6,
      event: {
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: 'before' }] },
      },
    })

    expect(lastFrame).toBeDefined()
    const order = lastFrame!.blocks.map((b) =>
      b.t === 'markdown' ? `text:${b.md}` : b.t === 'tool' ? `tool:${b.toolName}` : b.t
    )
    expect(order).toEqual(['text:before', 'tool:Read'])
    const markdownBlocks = lastFrame!.blocks.filter((b) => b.t === 'markdown')
    expect(markdownBlocks).toHaveLength(1)
  })

  test('Codex-style message_end-only assistant turn creates a segment instead of falling through to finalOutput', () => {
    let lastFrame: { blocks: Array<{ t: string; md?: string; toolName?: string }> } | undefined
    const manager = new SessionEventsManager('gateway-test', (_pid, _rid, frame) => {
      lastFrame = frame as never
    })

    manager.subscribe('codex-proj')
    manager.receive({
      projectId: 'codex-proj',
      runId: 'run-codex',
      seq: 1,
      event: {
        type: 'run_started',
        runId: 'run-codex',
        projectId: 'codex-proj',
        startedAt: 1,
      },
    })

    // tool first
    manager.receive({
      projectId: 'codex-proj',
      runId: 'run-codex',
      seq: 2,
      event: {
        type: 'tool_execution_start',
        toolUseId: 'tc1',
        toolName: 'Read',
        input: { file_path: '/c' },
      },
    })
    manager.receive({
      projectId: 'codex-proj',
      runId: 'run-codex',
      seq: 3,
      event: {
        type: 'tool_execution_end',
        toolUseId: 'tc1',
        toolName: 'Read',
        result: { content: [{ type: 'text', text: 'ok' }] },
      },
    })

    // ONLY message_end for the assistant text — no message_start, no message_update
    manager.receive({
      projectId: 'codex-proj',
      runId: 'run-codex',
      seq: 4,
      event: {
        type: 'message_end',
        messageId: 'msg-codex',
        message: { role: 'assistant', content: [{ type: 'text', text: 'codex final' }] },
      },
    })

    // Then turn_end with the same finalOutput — should NOT add a duplicate segment
    manager.receive({
      projectId: 'codex-proj',
      runId: 'run-codex',
      seq: 5,
      event: { type: 'turn_end', payload: { finalOutput: 'codex final' } },
    })

    expect(lastFrame).toBeDefined()
    const markdownBlocks = lastFrame!.blocks.filter((b) => b.t === 'markdown')
    expect(markdownBlocks).toHaveLength(1)
    expect(markdownBlocks[0]?.md).toBe('codex final')

    const order = lastFrame!.blocks.map((b) =>
      b.t === 'markdown' ? 'text' : b.t === 'tool' ? 'tool' : b.t
    )
    expect(order).toEqual(['tool', 'text'])
  })

  test('derived cumulative message_end does not duplicate existing streamed segments', () => {
    let lastFrame: { blocks: Array<{ t: string; md?: string; toolName?: string }> } | undefined
    const manager = new SessionEventsManager('gateway-test', (_pid, _rid, frame) => {
      lastFrame = frame as never
    })

    manager.subscribe('codex-proj')
    manager.receive({
      projectId: 'codex-proj',
      runId: 'run-streamed',
      seq: 1,
      event: {
        type: 'run_started',
        runId: 'run-streamed',
        projectId: 'codex-proj',
        startedAt: 1,
      },
    })
    manager.receive({
      projectId: 'codex-proj',
      runId: 'run-streamed',
      seq: 2,
      event: {
        type: 'message_start',
        messageId: 'msg-streamed',
        message: { role: 'assistant', content: '' },
      },
    })
    manager.receive({
      projectId: 'codex-proj',
      runId: 'run-streamed',
      seq: 3,
      event: { type: 'message_update', messageId: 'msg-streamed', textDelta: 'before' },
    })
    manager.receive({
      projectId: 'codex-proj',
      runId: 'run-streamed',
      seq: 4,
      event: {
        type: 'message_end',
        messageId: 'msg-streamed',
        message: { role: 'assistant', content: 'before' },
      },
    })

    manager.receive({
      projectId: 'codex-proj',
      runId: 'run-streamed',
      seq: 5,
      event: {
        type: 'message_end',
        message: { role: 'assistant', content: 'before' },
      },
    })

    expect(lastFrame).toBeDefined()
    const markdownBlocks = lastFrame!.blocks.filter((b) => b.t === 'markdown')
    expect(markdownBlocks).toHaveLength(1)
    expect(markdownBlocks[0]?.md).toBe('before')
  })

  test('two anchored message_end events (turn.message synthesized ids) keep both segments and interleave with a tool call by seq', () => {
    let lastFrame: { blocks: Array<{ t: string; md?: string; toolName?: string }> } | undefined
    const manager = new SessionEventsManager('gateway-test', (_pid, _rid, frame) => {
      lastFrame = frame as never
    })

    manager.subscribe('media-ingest')
    manager.receive({
      projectId: 'media-ingest',
      runId: 'run-turn-msg',
      seq: 1,
      event: {
        type: 'run_started',
        runId: 'run-turn-msg',
        projectId: 'media-ingest',
        startedAt: 1,
      },
    })
    manager.receive({
      projectId: 'media-ingest',
      runId: 'run-turn-msg',
      seq: 2,
      event: {
        type: 'message_end',
        messageId: 'hrc:2',
        message: { role: 'assistant', content: 'first prose' },
      },
    })
    manager.receive({
      projectId: 'media-ingest',
      runId: 'run-turn-msg',
      seq: 3,
      event: {
        type: 'tool_execution_start',
        toolUseId: 'toolu_x',
        toolName: 'Bash',
        input: { command: 'ls' },
      },
    })
    manager.receive({
      projectId: 'media-ingest',
      runId: 'run-turn-msg',
      seq: 4,
      event: {
        type: 'tool_execution_end',
        toolUseId: 'toolu_x',
        toolName: 'Bash',
        result: { content: [{ type: 'text', text: 'ok' }] },
      },
    })
    manager.receive({
      projectId: 'media-ingest',
      runId: 'run-turn-msg',
      seq: 5,
      event: {
        type: 'message_end',
        messageId: 'hrc:5',
        message: { role: 'assistant', content: 'second prose' },
      },
    })

    expect(lastFrame).toBeDefined()
    const visible = lastFrame!.blocks.filter((b) => b.t === 'markdown' || b.t === 'tool')
    expect(visible.map((b) => (b.t === 'markdown' ? b.md : `tool:${b.toolName}`))).toEqual([
      'first prose',
      'tool:Bash',
      'second prose',
    ])
  })
})
