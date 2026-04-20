import { describe, expect, test } from 'bun:test'

import { appendEvent, listEvents } from '../../src/index.js'
import { withTmpStore } from '../fixtures/tmp-store.js'

describe('03 source/target/transcript separation', () => {
  test('source metadata, semantic session, and transcript links round-trip separately', () => {
    withTmpStore((store) => {
      appendEvent(store, {
        projectId: 'demo',
        event: {
          kind: 'message.posted',
          ts: '2026-04-19T00:20:00.000Z',
          semanticSession: {
            scopeRef: 'agent:bob:project:demo:task:t7:role:reviewer',
            laneRef: 'main',
          },
          content: { kind: 'markdown', body: 'please review' },
          source: {
            gatewayId: 'discord',
            conversationRef: 'chan-1',
            threadRef: 'thread-42',
            messageRef: 'msg-99',
          },
          links: {
            taskId: 't7',
            conversationThreadId: 'conv-thread-9',
            conversationTurnId: 'turn-1',
          },
        },
      })

      const [event] = listEvents(store, {
        projectId: 'demo',
        sessionRef: {
          scopeRef: 'agent:bob:project:demo:task:t7:role:reviewer',
          laneRef: 'main',
        },
      })

      expect(event?.semanticSession).toEqual({
        scopeRef: 'agent:bob:project:demo:task:t7:role:reviewer',
        laneRef: 'main',
      })
      expect(event?.source).toEqual({
        gatewayId: 'discord',
        conversationRef: 'chan-1',
        threadRef: 'thread-42',
        messageRef: 'msg-99',
      })
      expect(event?.links?.conversationThreadId).toBe('conv-thread-9')
      expect(event?.links?.conversationTurnId).toBe('turn-1')
      expect(event?.source?.threadRef).not.toBe(event?.semanticSession?.scopeRef)
    })
  })
})
