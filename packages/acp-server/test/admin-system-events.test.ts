import { describe, expect, test } from 'bun:test'

import { withWiredServer } from './fixtures/wired-server.js'

describe('admin system events endpoints', () => {
  test('appends system events and lists them with filters', async () => {
    await withWiredServer(async (fixture) => {
      const created = await fixture.request({
        method: 'POST',
        path: '/v1/admin/system-events',
        body: {
          projectId: 'agent-spaces',
          kind: 'project.created',
          payload: { source: 'acceptance-test' },
          occurredAt: '2026-04-23T04:00:00.000Z',
        },
      })

      expect(created.status).toBe(201)
      expect(await fixture.json<{ event: { kind: string; projectId: string } }>(created)).toEqual({
        event: expect.objectContaining({ kind: 'project.created', projectId: 'agent-spaces' }),
      })

      const listResponse = await fixture.request({
        method: 'GET',
        path: '/v1/admin/system-events?projectId=agent-spaces&kind=project.created',
      })

      expect(listResponse.status).toBe(200)
      expect(
        await fixture.json<{ events: Array<{ kind: string; projectId: string }> }>(listResponse)
      ).toEqual({
        events: [expect.objectContaining({ kind: 'project.created', projectId: 'agent-spaces' })],
      })
    })
  })
})
