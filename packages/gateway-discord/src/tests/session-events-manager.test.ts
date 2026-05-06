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
})
