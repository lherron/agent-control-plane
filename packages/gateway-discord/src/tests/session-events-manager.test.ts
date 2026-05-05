import { describe, expect, test } from 'bun:test'

import { SessionEventsManager } from '../session-events-manager.js'

describe('SessionEventsManager internal run suppression', () => {
  test('ignores internal runs and suppresses subsequent events for that runId', () => {
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

    expect(manager.getRunState('control-plane', 'run-internal')).toBeUndefined()
    expect(renders).toHaveLength(0)

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
    expect(renders).toHaveLength(1)
    expect(renders[0]?.runId).toBe('run-user')
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
})
