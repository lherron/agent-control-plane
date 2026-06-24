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
    expect(requestedUrl.endsWith('/v1/example')).toBe(true)
  })

  test('preserves API status error messages', async () => {
    globalThis.fetch = mockFetch(async () => new Response('nope', { status: 503 }))

    await expect(fetchJson('/v1/example')).rejects.toThrow('API 503: /v1/example')
  })
})
