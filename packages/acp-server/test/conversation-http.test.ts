import { withWiredServer } from './fixtures/wired-server.js'

describe('conversation HTTP scaffold', () => {
  test('GET /v1/conversation/threads returns scaffold 501', async () => {
    await withWiredServer(async ({ json, request }) => {
      const response = await request({
        method: 'GET',
        path: '/v1/conversation/threads',
      })

      expect(response.status).toBe(501)
      expect(await json<{ error: string; code: string }>(response)).toEqual({
        error: 'not_implemented',
        code: 'pending_p1_impl',
      })
    })
  })

  test('GET /v1/conversation/threads/:threadId returns scaffold 501 before missing-thread semantics land', async () => {
    await withWiredServer(async ({ json, request }) => {
      const response = await request({
        method: 'GET',
        path: '/v1/conversation/threads/thread_missing',
      })

      expect(response.status).toBe(501)
      expect(await json<{ error: string; code: string }>(response)).toEqual({
        error: 'not_implemented',
        code: 'pending_p1_impl',
      })
    })
  })

  test('GET /v1/conversation/threads/:threadId/turns returns scaffold 501 even with audience filters', async () => {
    await withWiredServer(async ({ json, request }) => {
      const response = await request({
        method: 'GET',
        path: '/v1/conversation/threads/thread_123/turns?audience=human',
      })

      expect(response.status).toBe(501)
      expect(await json<{ error: string; code: string }>(response)).toEqual({
        error: 'not_implemented',
        code: 'pending_p1_impl',
      })
    })
  })
})
