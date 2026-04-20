import { describe, expect, test } from 'bun:test'

import { appendEvent, listEvents, listOpenHandoffs, listPendingWakes } from '../../src/index.js'
import { withTmpStore } from '../fixtures/tmp-store.js'

describe('05 project isolation', () => {
  test('queries are project-scoped', () => {
    withTmpStore((store) => {
      appendEvent(store, {
        projectId: 'project-a',
        event: {
          kind: 'handoff.declared',
          ts: '2026-04-19T00:40:00.000Z',
          links: { taskId: 'a1' },
        },
        handoff: {
          taskId: 'a1',
          kind: 'review',
          to: { kind: 'agent', agentId: 'alice' },
        },
        wake: {
          sessionRef: {
            scopeRef: 'agent:alice:project:project-a:task:a1:role:reviewer',
            laneRef: 'main',
          },
        },
      })

      appendEvent(store, {
        projectId: 'project-b',
        event: {
          kind: 'message.posted',
          ts: '2026-04-19T00:40:01.000Z',
          links: { taskId: 'b1' },
        },
      })

      expect(listEvents(store, { projectId: 'project-a' })).toHaveLength(1)
      expect(listEvents(store, { projectId: 'project-b' })).toHaveLength(1)
      expect(listOpenHandoffs(store, { projectId: 'project-b' })).toHaveLength(0)
      expect(
        listPendingWakes(store, {
          projectId: 'project-b',
          sessionRef: {
            scopeRef: 'agent:alice:project:project-a:task:a1:role:reviewer',
            laneRef: 'main',
          },
        })
      ).toHaveLength(0)
    })
  })
})
