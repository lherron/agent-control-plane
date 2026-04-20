import { describe, expect, test } from 'bun:test'

import { appendEvent, listEvents } from '../../src/index.js'
import { withTmpStore } from '../fixtures/tmp-store.js'

describe('02 append-only history', () => {
  test('corrections append a new event and leave earlier history intact', () => {
    withTmpStore((store) => {
      const first = appendEvent(store, {
        projectId: 'demo',
        event: {
          kind: 'message.posted',
          ts: '2026-04-19T00:10:00.000Z',
          content: { kind: 'text', body: 'first draft' },
        },
      })

      const correction = appendEvent(store, {
        projectId: 'demo',
        event: {
          kind: 'system.noted',
          ts: '2026-04-19T00:10:05.000Z',
          content: { kind: 'text', body: 'correction issued' },
          meta: { supersedesEventId: first.event.eventId },
        },
      })

      const events = listEvents(store, { projectId: 'demo' })
      expect(events).toHaveLength(2)
      expect(events[0]?.eventId).toBe(first.event.eventId)
      expect(events[0]?.content?.body).toBe('first draft')
      expect(events[1]?.eventId).toBe(correction.event.eventId)
      expect(events[1]?.meta?.supersedesEventId).toBe(first.event.eventId)
      expect(events.map((event) => event.seq)).toEqual([1, 2])
    })
  })
})
