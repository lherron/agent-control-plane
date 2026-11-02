import { expect, test } from 'bun:test'
import { withWiredServer } from './fixtures/wired-server.js'

test('retired maintenance routes are absent from the server', async () => {
  await withWiredServer(async (f) => {
    for (const operation of ['plan', 'apply']) {
      const reply = await f.request({
        method: 'POST',
        path: `/v1/admin/reconciler/acp-request-backfill/${operation}`,
        peer: { address: '127.0.0.1' },
        body: {},
      })
      expect(reply.status).toBe(404)
    }
  })
})
