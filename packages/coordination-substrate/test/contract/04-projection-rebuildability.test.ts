import { describe, expect, test } from 'bun:test'

import {
  appendEvent,
  cancelHandoff,
  consumeWake,
  listEvents,
  listOpenHandoffs,
  listPendingWakes,
} from '../../src/index.js'
import { withTmpStore } from '../fixtures/tmp-store.js'

describe('04 projection rebuildability', () => {
  test('replaying the ledger yields the same currently-open handoff and wake anchors', () => {
    withTmpStore((store) => {
      const review = appendEvent(store, {
        projectId: 'demo',
        event: {
          kind: 'handoff.declared',
          ts: '2026-04-19T00:30:00.000Z',
          links: { taskId: 't1' },
        },
        handoff: {
          taskId: 't1',
          kind: 'review',
          to: { kind: 'agent', agentId: 'reviewer' },
        },
      })

      const wake = appendEvent(store, {
        projectId: 'demo',
        event: {
          kind: 'attention.requested',
          ts: '2026-04-19T00:30:01.000Z',
          links: { taskId: 't1' },
        },
        wake: {
          sessionRef: {
            scopeRef: 'agent:reviewer:project:demo:task:t1:role:reviewer',
            laneRef: 'main',
          },
          reason: 'pick up review',
        },
      })

      const closed = appendEvent(store, {
        projectId: 'demo',
        event: {
          kind: 'handoff.declared',
          ts: '2026-04-19T00:30:02.000Z',
          links: { taskId: 't2' },
        },
        handoff: {
          taskId: 't2',
          kind: 'blocked',
          to: { kind: 'human', ref: 'operator' },
        },
      })

      cancelHandoff(store, {
        handoffId: closed.handoff!.handoffId,
        cancelledAt: '2026-04-19T00:30:03.000Z',
      })
      consumeWake(store, { wakeId: wake.wake!.wakeId, consumedAt: '2026-04-19T00:30:04.000Z' })

      const liveOpen = listOpenHandoffs(store, { projectId: 'demo' })
      const livePending = listPendingWakes(store, {
        projectId: 'demo',
        sessionRef: {
          scopeRef: 'agent:reviewer:project:demo:task:t1:role:reviewer',
          laneRef: 'main',
        },
      })
      const events = listEvents(store, { projectId: 'demo' })

      const rebuiltOpenEventIds = events
        .filter((event) => event.kind === 'handoff.declared')
        .map((event) => event.eventId)

      expect(liveOpen.map((handoff) => handoff.sourceEventId)).toEqual([review.event.eventId])
      expect(livePending).toHaveLength(0)
      expect(rebuiltOpenEventIds).toContain(review.event.eventId)
      expect(rebuiltOpenEventIds).toContain(closed.event.eventId)
    })
  })
})
