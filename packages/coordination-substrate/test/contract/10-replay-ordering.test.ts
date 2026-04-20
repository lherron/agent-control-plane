import { describe, expect, test } from 'bun:test'

import { appendEvent, listEvents } from '../../src/index.js'
import { withTmpStore } from '../fixtures/tmp-store.js'

describe('10 replay ordering', () => {
  test('events return in stable per-project sequence order', () => {
    withTmpStore((store) => {
      appendEvent(store, {
        projectId: 'demo',
        event: { kind: 'system.noted', ts: '2026-04-19T01:30:00.000Z' },
      })
      appendEvent(store, {
        projectId: 'demo',
        event: { kind: 'message.posted', ts: '2026-04-19T01:30:01.000Z' },
      })
      appendEvent(store, {
        projectId: 'demo',
        event: { kind: 'artifact.linked', ts: '2026-04-19T01:30:02.000Z' },
      })

      const events = listEvents(store, { projectId: 'demo' })
      expect(events.map((event) => event.seq)).toEqual([1, 2, 3])
      expect(events.map((event) => event.kind)).toEqual([
        'system.noted',
        'message.posted',
        'artifact.linked',
      ])
    })
  })
})
