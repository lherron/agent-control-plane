import { describe, expect, test } from 'bun:test'

import { islandCorsOrigin, islandPreflight, withIslandCors } from '../src/island-cors.js'

const origin = 'loggia-plugin://ui-concierge'
const loopback = { address: '127.0.0.1' }

function request(method: string, headers: Record<string, string>): Request {
  return new Request('http://127.0.0.1:18470/v1/inputs', { method, headers })
}

describe('Loggia island CORS (T-11492)', () => {
  test('a loopback island origin is recognised', () => {
    expect(islandCorsOrigin(request('POST', { origin }), loopback)).toBe(origin)
    expect(islandCorsOrigin(request('POST', { origin }), { address: '::1' })).toBe(origin)
  })

  test('web origins, a missing origin and non-loopback peers are not', () => {
    expect(
      islandCorsOrigin(request('POST', { origin: 'https://evil.example' }), loopback)
    ).toBeUndefined()
    expect(islandCorsOrigin(request('POST', {}), loopback)).toBeUndefined()
    expect(islandCorsOrigin(request('POST', { origin }), { address: '100.64.0.7' })).toBeUndefined()
    expect(islandCorsOrigin(request('POST', { origin }), undefined)).toBeUndefined()
  })

  test('a preflight answers 204 with the requested method and headers', () => {
    const reply = islandPreflight(
      origin,
      request('OPTIONS', {
        origin,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      })
    )
    expect(reply.status).toBe(204)
    expect(reply.headers.get('access-control-allow-origin')).toBe(origin)
    expect(reply.headers.get('access-control-allow-methods')).toContain('POST')
    expect(reply.headers.get('access-control-allow-headers')).toBe('content-type')
    expect(reply.headers.get('vary')).toContain('Origin')
  })

  test('a response gains the allow-origin header and keeps status and body', async () => {
    const base = Response.json({ ok: true }, { status: 201 })
    const reply = withIslandCors(base, origin)
    expect(reply.status).toBe(201)
    expect(reply.headers.get('access-control-allow-origin')).toBe(origin)
    expect(await reply.json()).toEqual({ ok: true })
  })
})
