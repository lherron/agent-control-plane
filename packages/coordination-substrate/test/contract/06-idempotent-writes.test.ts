import { describe, expect, test } from 'bun:test'

import { appendEvent, listEvents } from '../../src/index.js'
import { withTmpStore } from '../fixtures/tmp-store.js'

describe('06 idempotent writes', () => {
  test('same idempotency key returns the existing event without duplication', () => {
    withTmpStore((store) => {
      const first = appendEvent(store, {
        projectId: 'demo',
        idempotencyKey: 'append-1',
        event: {
          kind: 'message.posted',
          ts: '2026-04-19T00:50:00.000Z',
          content: { kind: 'text', body: 'once only' },
        },
      })

      const second = appendEvent(store, {
        projectId: 'demo',
        idempotencyKey: 'append-1',
        event: {
          kind: 'message.posted',
          ts: '2026-04-19T00:50:01.000Z',
          content: { kind: 'text', body: 'should collapse' },
        },
      })

      expect(second.event.eventId).toBe(first.event.eventId)
      expect(listEvents(store, { projectId: 'demo' })).toHaveLength(1)
    })
  })
})
