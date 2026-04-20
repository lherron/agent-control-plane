import { describe, expect, test } from 'bun:test'

import { appendEvent, listEvents } from '../../src/index.js'
import { withTmpStore } from '../fixtures/tmp-store.js'

describe('09 ACP delivery boundary', () => {
  test('appendEvent persists and records local dispatch stubs without attempting delivery', () => {
    withTmpStore((store) => {
      const result = appendEvent(store, {
        projectId: 'demo',
        event: {
          kind: 'attention.requested',
          ts: '2026-04-19T01:20:00.000Z',
        },
        wake: {
          sessionRef: {
            scopeRef: 'agent:tester:project:demo:task:t11:role:tester',
            laneRef: 'main',
          },
        },
        localRecipients: [{ kind: 'agent', agentId: 'tester' }],
      })

      expect(listEvents(store, { projectId: 'demo' })).toHaveLength(1)
      expect(result.localDispatchAttempts).toEqual([
        expect.objectContaining({ state: 'queued', target: { kind: 'agent', agentId: 'tester' } }),
      ])
    })
  })
})
