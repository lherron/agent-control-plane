import { describe, expect, test } from 'bun:test'

import { listEvents, listOpenHandoffs, listPendingWakes } from 'coordination-substrate'

import { withWiredServer } from './fixtures/wired-server.js'

describe('POST /v1/messages', () => {
  test('appends a coordination event', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request({
        method: 'POST',
        path: '/v1/messages',
        body: {
          projectId: fixture.seed.projectId,
          event: {
            ts: '2026-04-19T00:00:00.000Z',
            kind: 'message.posted',
            content: { kind: 'text', body: 'hello' },
          },
        },
      })

      expect(response.status).toBe(201)
      expect(listEvents(fixture.coordStore, { projectId: fixture.seed.projectId })).toHaveLength(1)
    })
  })

  test('appends an event with handoff and wake', async () => {
    await withWiredServer(async (fixture) => {
      const sessionRef = {
        scopeRef: 'agent:curly:project:demo:task:T-70002:role:tester',
        laneRef: 'main',
      } as const

      const response = await fixture.request({
        method: 'POST',
        path: '/v1/messages',
        body: {
          projectId: fixture.seed.projectId,
          event: {
            ts: '2026-04-19T00:00:01.000Z',
            kind: 'handoff.declared',
            links: { taskId: 'T-70002' },
          },
          handoff: {
            taskId: 'T-70002',
            to: { kind: 'session', sessionRef },
            targetSession: sessionRef,
            kind: 'review',
          },
          wake: {
            sessionRef,
            reason: 'review ready',
          },
        },
      })

      expect(response.status).toBe(201)
      expect(
        listOpenHandoffs(fixture.coordStore, {
          projectId: fixture.seed.projectId,
          taskId: 'T-70002',
        })
      ).toHaveLength(1)
      expect(
        listPendingWakes(fixture.coordStore, { projectId: fixture.seed.projectId, sessionRef })
      ).toHaveLength(1)
    })
  })

  test('returns 422 for non-canonical wake targets', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request({
        method: 'POST',
        path: '/v1/messages',
        body: {
          projectId: fixture.seed.projectId,
          event: {
            ts: '2026-04-19T00:00:02.000Z',
            kind: 'attention.requested',
          },
          wake: {
            sessionRef: {
              scopeRef: 'agent:curly:project:demo:task:T-70003:role:tester',
            },
            reason: 'bad wake',
          },
        },
      })

      expect(response.status).toBe(422)
    })
  })
})
