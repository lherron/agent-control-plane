import { describe, expect, test } from 'bun:test'

import { appendEvent, listOpenHandoffs } from '../../src/index.js'
import { withTmpStore } from '../fixtures/tmp-store.js'

describe('07 handoff visibility', () => {
  test('open handoffs are queryable without inferring from text', () => {
    withTmpStore((store) => {
      appendEvent(store, {
        projectId: 'demo',
        event: {
          kind: 'handoff.declared',
          ts: '2026-04-19T01:00:00.000Z',
          content: { kind: 'text', body: 'please review' },
          links: { taskId: 't-review' },
        },
        handoff: {
          taskId: 't-review',
          kind: 'review',
          to: { kind: 'agent', agentId: 'reviewer' },
        },
      })

      appendEvent(store, {
        projectId: 'demo',
        event: {
          kind: 'message.posted',
          ts: '2026-04-19T01:00:01.000Z',
          content: { kind: 'text', body: 'human says please approve' },
          links: { taskId: 't-chat' },
        },
      })

      const open = listOpenHandoffs(store, {
        projectId: 'demo',
        toParticipant: { kind: 'agent', agentId: 'reviewer' },
      })

      expect(open).toHaveLength(1)
      expect(open[0]?.taskId).toBe('t-review')
      expect(open[0]?.kind).toBe('review')
    })
  })
})
