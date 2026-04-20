import { describe, expect, test } from 'bun:test'

import { appendEvent, listPendingWakes } from '../../src/index.js'
import { withTmpStore } from '../fixtures/tmp-store.js'

describe('01 exact semantic triggering', () => {
  test('wake requires a canonical SessionRef with explicit laneRef', () => {
    withTmpStore((store) => {
      expect(() =>
        appendEvent(store, {
          projectId: 'demo',
          event: {
            kind: 'attention.requested',
            ts: '2026-04-19T00:00:00.000Z',
          },
          wake: {
            sessionRef: { scopeRef: 'agent:alice:project:demo:task:t1:role:tester' } as never,
            reason: 'needs review',
          },
        })
      ).toThrow(/canonical SessionRef/i)

      const appended = appendEvent(store, {
        projectId: 'demo',
        event: {
          kind: 'attention.requested',
          ts: '2026-04-19T00:00:01.000Z',
        },
        wake: {
          sessionRef: {
            scopeRef: 'agent:alice:project:demo:task:t1:role:tester',
            laneRef: 'main',
          },
          reason: 'needs review',
        },
      })

      expect(appended.wake?.sessionRef.laneRef).toBe('main')
      expect(
        listPendingWakes(store, {
          projectId: 'demo',
          sessionRef: {
            scopeRef: 'agent:alice:project:demo:task:t1:role:tester',
            laneRef: 'main',
          },
        })
      ).toHaveLength(1)
    })
  })
})
