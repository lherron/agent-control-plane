import { describe, expect, test } from 'bun:test'

import { appendEvent, listEvents, listOpenHandoffs, listPendingWakes } from '../../src/index.js'
import { withTmpStore } from '../fixtures/tmp-store.js'

describe('08 HAL read-model support', () => {
  test('coordination slice is derivable from public queries', () => {
    withTmpStore((store) => {
      appendEvent(store, {
        projectId: 'demo',
        event: {
          kind: 'message.posted',
          ts: '2026-04-19T01:10:00.000Z',
          participants: [{ kind: 'agent', agentId: 'implementer' }],
          links: { taskId: 't9', conversationThreadId: 'thread-hal' },
        },
      })

      appendEvent(store, {
        projectId: 'demo',
        event: {
          kind: 'handoff.declared',
          ts: '2026-04-19T01:10:01.000Z',
          links: { taskId: 't9', conversationThreadId: 'thread-hal' },
        },
        handoff: {
          taskId: 't9',
          kind: 'review',
          to: { kind: 'agent', agentId: 'tester' },
          targetSession: {
            scopeRef: 'agent:tester:project:demo:task:t9:role:tester',
            laneRef: 'main',
          },
        },
        wake: {
          sessionRef: {
            scopeRef: 'agent:tester:project:demo:task:t9:role:tester',
            laneRef: 'main',
          },
          reason: 'review requested',
        },
      })

      appendEvent(store, {
        projectId: 'demo',
        event: {
          kind: 'message.posted',
          ts: '2026-04-19T01:10:02.000Z',
          links: { taskId: 't10', conversationThreadId: 'other-thread' },
        },
      })

      const recentEvents = listEvents(store, { projectId: 'demo', taskId: 't9' })
      const pendingHandoff = listOpenHandoffs(store, { projectId: 'demo', taskId: 't9' })[0]
      const pendingWake = listPendingWakes(store, {
        projectId: 'demo',
        sessionRef: {
          scopeRef: 'agent:tester:project:demo:task:t9:role:tester',
          laneRef: 'main',
        },
      })[0]
      const linkedConversation = listEvents(store, {
        projectId: 'demo',
        conversationThreadId: 'thread-hal',
      })

      expect(recentEvents.at(-1)?.eventId).toBe(pendingHandoff?.sourceEventId)
      expect(pendingWake?.sourceEventId).toBe(pendingHandoff?.sourceEventId)
      expect(linkedConversation.map((event) => event.eventId)).toEqual(
        recentEvents.map((event) => event.eventId)
      )
      expect(linkedConversation).toHaveLength(2)
    })
  })
})
