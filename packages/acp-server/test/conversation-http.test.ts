import { withWiredServer } from './fixtures/wired-server.js'

describe('conversation HTTP scaffold', () => {
  test('without a conversation store, every conversation read route returns 501 pending_p1_impl', async () => {
    await withWiredServer(async ({ json, request }) => {
      for (const path of [
        '/v1/conversation/threads',
        '/v1/conversation/threads/thread_missing',
        '/v1/conversation/threads/thread_123/turns?audience=human',
      ]) {
        const response = await request({ method: 'GET', path })

        expect(response.status, path).toBe(501)
        expect(await json<{ error: string; code: string }>(response), path).toEqual({
          error: 'not_implemented',
          code: 'pending_p1_impl',
        })
      }
    })
  })
})
