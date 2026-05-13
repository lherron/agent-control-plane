import { describe, expect, test } from 'bun:test'

import { renderFrameToDiscordContent } from '../render.js'
import { SessionEventsManager } from '../session-events-manager.js'
import type { RenderFrame, SessionEventEnvelope } from '../types.js'

const TEST_SESSION = 'agent:larry:project:agent-spaces/lane:main'

function noticeEnvelope(seq: number, level: 'info' | 'warn' | 'error', message: string) {
  return {
    sessionRef: TEST_SESSION,
    projectId: 'agent-spaces',
    runId: 'run_notice',
    seq,
    event: {
      type: 'notice',
      level,
      message,
    },
  } as unknown as SessionEventEnvelope
}

describe('SessionEventsManager notice rendering', () => {
  test('renders the latest notices inline and counts them in the 12-line cap', () => {
    const frames: RenderFrame[] = []
    const manager = new SessionEventsManager(
      'gateway-test',
      (_sessionRef, _projectId, _runId, frame) => {
        frames.push(frame)
      }
    )

    manager.subscribe(TEST_SESSION, 'agent-spaces')
    manager.receive({
      sessionRef: TEST_SESSION,
      projectId: 'agent-spaces',
      runId: 'run_notice',
      seq: 1,
      event: {
        type: 'run_started',
        runId: 'run_notice',
        projectId: 'agent-spaces',
        startedAt: 1,
      },
    })

    manager.receive(noticeEnvelope(2, 'info', 'connected to live session stream'))
    manager.receive(noticeEnvelope(3, 'warn', 'tool output was compacted'))
    manager.receive(noticeEnvelope(4, 'error', 'tool progress edit failed'))
    for (let index = 0; index < 12; index += 1) {
      manager.receive(noticeEnvelope(index + 5, 'info', `extra notice ${index}`))
    }

    const content = renderFrameToDiscordContent(frames.at(-1) as RenderFrame, 2000)
    expect(content).toContain('_... +3 earlier tools_')
    expect(content).not.toContain('ℹ️ connected to live session stream')
    expect(content).not.toContain('⚠️ tool output was compacted')
    expect(content).not.toContain('❌ tool progress edit failed')
    expect(content).toContain('ℹ️ extra notice 0')
    expect(content).toContain('ℹ️ extra notice 11')

    const visibleNoticeLines = content
      .split('\n')
      .filter((line) => line.startsWith('ℹ️ ') || line.startsWith('⚠️ ') || line.startsWith('❌ '))
    expect(visibleNoticeLines.length).toBeLessThanOrEqual(12)
  })
})
