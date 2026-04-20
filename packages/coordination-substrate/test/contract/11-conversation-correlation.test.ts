import { describe, expect, test } from 'bun:test'

import { appendEvent, listEventLinks, listEvents } from '../../src/index.js'
import { withTmpStore } from '../fixtures/tmp-store.js'

describe('11 conversation correlation', () => {
  test('events remain queryable by conversation thread without changing semantic ownership', () => {
    withTmpStore((store) => {
      appendEvent(store, {
        projectId: 'demo',
        event: {
          kind: 'message.posted',
          ts: '2026-04-19T01:40:00.000Z',
          semanticSession: {
            scopeRef: 'agent:alice:project:demo:task:t44:role:implementer',
            laneRef: 'main',
          },
          links: {
            taskId: 't44',
            conversationThreadId: 'thread-44',
            conversationTurnId: 'turn-1',
          },
        },
      })

      appendEvent(store, {
        projectId: 'demo',
        event: {
          kind: 'system.noted',
          ts: '2026-04-19T01:40:01.000Z',
          semanticSession: {
            scopeRef: 'agent:alice:project:demo:task:t44:role:implementer',
            laneRef: 'main',
          },
          links: {
            taskId: 't44',
            conversationThreadId: 'thread-44',
            conversationTurnId: 'turn-2',
          },
        },
      })

      const correlated = listEvents(store, {
        projectId: 'demo',
        conversationThreadId: 'thread-44',
      })
      const links = listEventLinks(store, {
        projectId: 'demo',
        conversationThreadId: 'thread-44',
      })

      expect(correlated).toHaveLength(2)
      expect(links.map((link) => link.conversationTurnId)).toEqual(['turn-1', 'turn-2'])
      expect(
        correlated.every((event) => event.semanticSession?.scopeRef.includes(':task:t44'))
      ).toBe(true)
    })
  })
})
