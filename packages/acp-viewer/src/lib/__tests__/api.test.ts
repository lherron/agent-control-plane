import { afterEach, describe, expect, test } from 'bun:test'

import { fetchJson } from '../api'

const originalFetch = globalThis.fetch

function mockFetch(handler: (input: URL | RequestInfo) => Promise<Response>): typeof fetch {
  return Object.assign(handler, { preconnect: originalFetch.preconnect }) as typeof fetch
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('fetchJson', () => {
  test('returns parsed JSON from the shared API base URL helper', async () => {
    let requestedUrl = ''
    globalThis.fetch = mockFetch(async (input) => {
      requestedUrl = String(input)
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    })

    await expect(fetchJson<{ ok: boolean }>('/v1/example')).resolves.toEqual({ ok: true })
    // The shipped default base (no VITE_ACP_VIEWER_API_BASE_URL, not a dev build)
    // is the local acp-server; a dropped or wrong base must fail here.
    expect(requestedUrl).toBe('http://127.0.0.1:18470/v1/example')
  })

  test("a non-2xx response rejects with 'API <status>: <path>'", async () => {
    globalThis.fetch = mockFetch(async () => new Response('nope', { status: 503 }))

    await expect(fetchJson('/v1/example')).rejects.toThrow('API 503: /v1/example')
  })
})
