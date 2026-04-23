import { describe, expect, test } from 'bun:test'

import { withWiredServer } from './fixtures/wired-server.js'

describe('POST /v1/messages (deprecated — 410 Gone)', () => {
  test('returns 410 for raw coordination append body', async () => {
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

      expect(response.status).toBe(410)
      expect(await fixture.json<{ error: { code: string } }>(response)).toMatchObject({
        error: { code: 'route_moved' },
      })
    })
  })

  test('returns 410 for raw coordination append with handoff and wake', async () => {
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

      expect(response.status).toBe(410)
      expect(await fixture.json<{ error: { code: string } }>(response)).toMatchObject({
        error: { code: 'route_moved' },
      })
    })
  })
})
