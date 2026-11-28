import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { withWiredServer } from '../fixtures/wired-server.js'
import { type PluginFixture, createPluginFixture } from './fixtures.js'

const local = { address: '127.0.0.1' }
const AUDIO = Buffer.from('0123456789abcdefghij')

type Seen = { path: string; method: string; headers: Headers }

function fakeOrigin() {
  const seen: Seen[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      seen.push({
        path: url.pathname + url.search,
        method: request.method,
        headers: request.headers,
      })
      const common = {
        'content-type': 'audio/mp4',
        'accept-ranges': 'bytes',
        etag: '"v1"',
        'set-cookie': 'session=leak',
        'www-authenticate': 'Basic',
      }
      if (request.headers.get('if-none-match') === '"v1"') {
        return new Response(null, { status: 304, headers: { etag: '"v1"' } })
      }
      const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.get('range') ?? '')
      if (range !== null) {
        const [start, end] = [Number(range[1]), Number(range[2])]
        return new Response(AUDIO.subarray(start, end + 1), {
          status: 206,
          headers: { ...common, 'content-range': `bytes ${start}-${end}/${AUDIO.length}` },
        })
      }
      return new Response(AUDIO, { headers: common })
    },
  })
  return { seen, server }
}

let fx: PluginFixture
let origin: ReturnType<typeof fakeOrigin>
beforeEach(() => {
  fx = createPluginFixture()
  origin = fakeOrigin()
  fx.writePlugin(
    'sp',
    {
      pages: {
        'read-aloud': {
          title: 'Read aloud',
          icon: 'waveform',
          mounts: { 'signal-pipeline': { ops: ['sp.read_aloud_request'] } },
          assets: {
            origin: `http://127.0.0.1:${origin.server.port}`,
            prefix: '/api/read-aloud/items/',
          },
        },
        noassets: { title: 'N', icon: 'n', mounts: { x: { ops: ['a'] } } },
      },
    },
    { 'read-aloud': { 'index.html': 'x' }, noassets: { 'index.html': 'x' } }
  )
})
afterEach(() => {
  origin.server.stop(true)
  fx.cleanup()
})

const base = '/v1/mobile/plugins/sp/pages/read-aloud/asset/'

async function withServer(
  run: (
    request: (method: string, path: string, headers?: HeadersInit) => Promise<Response>
  ) => Promise<void>
) {
  await withWiredServer(
    async ({ server }) => {
      await run((method, path, headers = {}) =>
        server.handler(new Request(`http://acp.test${path}`, { method, headers }), { peer: local })
      )
    },
    { pluginPages: fx.options }
  )
}

describe('plugin page asset proxy', () => {
  test('Range is forwarded and 206 passes through; credentials stripped both ways', async () => {
    await withServer(async (request) => {
      const response = await request('GET', `${base}ra-1/audio`, {
        range: 'bytes=2-5',
        authorization: 'Bearer phone-token',
        cookie: 'a=b',
        'x-principal': 'agent:evil',
      })
      expect(response.status).toBe(206)
      expect(Buffer.from(await response.arrayBuffer()).toString()).toBe('2345')
      expect(response.headers.get('content-range')).toBe('bytes 2-5/20')
      expect(response.headers.get('content-type')).toBe('audio/mp4')
      expect(response.headers.get('accept-ranges')).toBe('bytes')
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(response.headers.get('set-cookie')).toBeNull()
      expect(response.headers.get('www-authenticate')).toBeNull()
      const seen = origin.seen.at(-1)!
      expect(seen.path).toBe('/api/read-aloud/items/ra-1/audio')
      expect(seen.headers.get('range')).toBe('bytes=2-5')
      expect(seen.headers.get('authorization')).toBeNull()
      expect(seen.headers.get('cookie')).toBeNull()
      expect(seen.headers.get('x-principal')).toBe('user:lance')
    })
  })

  test('HEAD and conditional headers pass through', async () => {
    await withServer(async (request) => {
      const head = await request('HEAD', `${base}ra-1/audio`)
      expect(head.status).toBe(200)
      expect(origin.seen.at(-1)!.method).toBe('HEAD')
      const cached = await request('GET', `${base}ra-1/audio`, { 'if-none-match': '"v1"' })
      expect(cached.status).toBe(304)
    })
  })

  test('a path escaping the prefix is refused and never forwarded', async () => {
    await withServer(async (request) => {
      for (const ref of [
        '..%2F..%2Fsecret',
        '%2e%2e%2f%2e%2e%2fsecret',
        'a%2F..%2F..%2F..%2Fsecret',
        '..%5Csecret',
        '%00x',
      ]) {
        const response = await request('GET', base + ref)
        expect(response.status).toBe(400)
        const body: unknown = await response.json()
        expect(body).toMatchObject({ error: { code: 'invalid_asset_ref' } })
      }
      expect(origin.seen).toHaveLength(0)
    })
  })

  test('only GET and HEAD; pages without assets and unknown pages have no asset route', async () => {
    await withServer(async (request) => {
      expect((await request('POST', `${base}ra-1/audio`)).status).toBe(404)
      expect((await request('GET', '/v1/mobile/plugins/sp/pages/noassets/asset/x')).status).toBe(
        404
      )
      expect((await request('GET', '/v1/mobile/plugins/sp/pages/nope/asset/x')).status).toBe(404)
      expect(origin.seen).toHaveLength(0)
    })
  })

  test('an unreachable origin answers 503 asset_unavailable', async () => {
    origin.server.stop(true)
    await withServer(async (request) => {
      const response = await request('GET', `${base}ra-1/audio`)
      expect(response.status).toBe(503)
      const body: unknown = await response.json()
      expect(body).toMatchObject({ error: { code: 'asset_unavailable' } })
    })
  })
})
