/**
 * Loggia island CORS (T-11492), driven through the listener's in-process
 * `fetch` — the entry Bun.serve calls — with the socket peer supplied the way
 * Bun's `server.requestIP` would.
 */
import { describe, expect, test } from 'bun:test'

import { createAcpListenerHandlers } from '../src/acp-listener.js'
import { resolveAcpServerDeps } from '../src/deps.js'

import { withWiredServer } from './fixtures/wired-server.js'

const origin = 'loggia-plugin://ui-concierge'

type Peer = { address: string; family: string; port: number } | null

async function listenerFetch(
  peer: Peer,
  method: string,
  headers: Record<string, string>,
  body?: unknown
): Promise<Response> {
  return withWiredServer(async (fixture) => {
    const handlers = createAcpListenerHandlers({
      acpServer: fixture.server,
      deps: resolveAcpServerDeps(fixture.deps),
      handleCapRpc: async () => Response.json({ jsonrpc: '2.0', id: 1, result: {} }),
    })
    const response = await handlers.fetch(
      new Request('http://127.0.0.1:18470/v1/inputs', {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
      { requestIP: () => peer, upgrade: () => false }
    )
    if (response === undefined) throw new Error('listener returned no response')
    // Read the body inside the fixture, before its stores close.
    const text = await response.text()
    return new Response(text.length > 0 ? text : null, {
      status: response.status,
      headers: response.headers,
    })
  })
}

function peerAt(address: string): Peer {
  return { address, family: address.includes(':') ? 'IPv6' : 'IPv4', port: 50000 }
}

describe('Loggia island CORS (T-11492)', () => {
  test('a routed response to a loopback island keeps its status and body and gains allow-origin', async () => {
    for (const address of ['127.0.0.1', '::1']) {
      const reply = await listenerFetch(
        peerAt(address),
        'POST',
        { origin, 'content-type': 'application/json' },
        {}
      )
      expect(reply.status).toBe(400)
      expect(reply.headers.get('access-control-allow-origin')).toBe(origin)
      expect(reply.headers.get('vary')).toContain('Origin')
      expect(await reply.json()).toEqual({
        error: {
          code: 'malformed_request',
          message: 'sessionRef must be an object',
          details: { field: 'sessionRef' },
        },
      })
    }
  })

  test('web origins, missing origins and non-loopback peers get no CORS grant', async () => {
    const cases: Array<[string, Peer, Record<string, string>]> = [
      ['web origin', peerAt('127.0.0.1'), { origin: 'https://evil.example' }],
      ['no origin', peerAt('127.0.0.1'), {}],
      ['tailnet peer', peerAt('100.64.0.7'), { origin }],
      ['unobservable peer', null, { origin }],
    ]
    for (const [label, peer, headers] of cases) {
      const reply = await listenerFetch(
        peer,
        'POST',
        { ...headers, 'content-type': 'application/json' },
        {}
      )
      expect({ label, allow: reply.headers.get('access-control-allow-origin') }).toEqual({
        label,
        allow: null,
      })
      // Still routed normally, not answered as a preflight.
      expect({ label, status: reply.status }).toEqual({ label, status: 400 })

      const preflight = await listenerFetch(peer, 'OPTIONS', {
        ...headers,
        'access-control-request-method': 'POST',
      })
      expect({ label, status: preflight.status }).not.toEqual({ label, status: 204 })
      expect(preflight.headers.get('access-control-allow-origin')).toBeNull()
    }
  })

  test('an island preflight from loopback answers 204 echoing the requested headers', async () => {
    const reply = await listenerFetch(peerAt('127.0.0.1'), 'OPTIONS', {
      origin,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type',
    })
    expect(reply.status).toBe(204)
    expect(reply.headers.get('access-control-allow-origin')).toBe(origin)
    expect(reply.headers.get('access-control-allow-methods')).toContain('POST')
    expect(reply.headers.get('access-control-allow-headers')).toBe('content-type')
    expect(reply.headers.get('vary')).toContain('Origin')
  })
})
