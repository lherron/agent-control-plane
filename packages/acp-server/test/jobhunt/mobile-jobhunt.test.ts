import { describe, expect, test } from 'bun:test'
import { createMobileAuthStore } from '../../src/mobile-auth/store.js'
import { withWiredServer } from '../fixtures/wired-server.js'

const local = { address: '127.0.0.1' }
const remote = { address: '100.73.60.81' }
const routes = [
  ['GET', '/triage', '/api/hunt/mobile/triage'],
  ['GET', '/leads/lead:1', '/api/hunt/mobile/leads/lead:1'],
  ['POST', '/leads/lead:1/decision', '/api/hunt/mobile/leads/lead:1/decision'],
  ['POST', '/leads/lead:1/ask', '/api/hunt/leads/lead:1/ask'],
] as const
const prefix = '/v1/mobile/jobhunt'
const rawBody = '{ "revision": 7, "unknown": {"url":"http://evil.test"} }'
const success = '{ "lead": {"revision":7}, "decision":"yes", "tailoring":{"error":"busy"} }\n'
const stale =
  '{ "error": {"code":"stale_revision", "message":"stale", "details":{"revision":8}} }\n'

function fakeJobhunt(mode: 'json' | 'hang' | 'bad' | 'drop' | 'redirect' = 'json') {
  const calls: { path: string; method: string; headers: Headers; body: string }[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      calls.push({
        path: url.pathname + url.search,
        method: request.method,
        headers: request.headers,
        body: await request.text(),
      })
      if (mode === 'hang') return new Promise<Response>(() => {})
      if (mode === 'drop') {
        server.stop(true)
        return new Promise<Response>(() => {})
      }
      if (mode === 'bad') return new Response('not json', { status: 200 })
      if (mode === 'redirect')
        return new Response(success, { status: 307, headers: { location: '/not-allowed' } })
      return new Response(url.searchParams.has('stale') ? stale : success, {
        status: url.searchParams.has('stale') ? 409 : 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  })
  return {
    calls,
    server,
    config: { baseUrl: server.url.origin, getDeadlineMs: 30, postDeadlineMs: 30 },
  }
}

async function withFake(
  run: (fake: ReturnType<typeof fakeJobhunt>) => Promise<void>,
  mode: Parameters<typeof fakeJobhunt>[0] = 'json'
) {
  const fake = fakeJobhunt(mode)
  try {
    await run(fake)
  } finally {
    fake.server.stop(true)
  }
}

describe('mobile Jobhunt forwarding through the ACP router', () => {
  test('all four routes preserve status, response bytes, query and body; headers are server owned', async () => {
    await withFake(async (fake) => {
      await withWiredServer(
        async ({ server }) => {
          for (const [method, path, upstream] of routes) {
            for (const query of ['?q=a%20b&q=%2F', '?stale=1']) {
              const response = await server.handler(
                new Request(`http://acp.test${prefix}${path}${query}`, {
                  method,
                  headers: {
                    'X-Principal': 'agent:evil',
                    authorization: 'Bearer secret',
                    cookie: 'secret=1',
                  },
                  ...(method === 'POST' ? { body: rawBody } : {}),
                }),
                { peer: local }
              )
              expect(response.status).toBe(query.includes('stale') ? 409 : 200)
              expect(await response.text()).toBe(query.includes('stale') ? stale : success)
              expect(response.headers.get('cache-control')).toBe('no-store')
              const call = fake.calls.at(-1)!
              expect(call.path).toBe(upstream + query)
              expect(call.method).toBe(method)
              expect(call.body).toBe(method === 'POST' ? rawBody : '')
              expect(call.headers.get('x-principal')).toBe('user:lance')
              expect(call.headers.get('authorization')).toBeNull()
              expect(call.headers.get('cookie')).toBeNull()
              expect(call.headers.get('accept')).toBe('application/json')
              expect(call.headers.get('content-type')).toBe('application/json')
            }
          }
          expect(fake.calls).toHaveLength(8)
        },
        { jobhunt: fake.config }
      )
    })
  })

  for (const enforce of [false, true]) {
    test(`strict auth with enforcement=${enforce}; refused calls never reach Jobhunt; ordinary routes retain policy`, async () => {
      const store = createMobileAuthStore()
      const token = store.redeemPairingCode(store.mintPairingCode().code)!.token
      store.setEnforce(enforce)
      await withFake(async (fake) => {
        await withWiredServer(
          async ({ request }) => {
            for (const [method, path] of routes) {
              for (const headers of [
                {},
                { authorization: 'Bearer invalid', 'x-forwarded-for': '127.0.0.1' },
              ]) {
                const response = await request({
                  method,
                  path: prefix + path,
                  peer: remote,
                  headers,
                  body: method === 'POST' ? {} : undefined,
                })
                expect(response.status).toBe(401)
                expect(await response.json()).toEqual({ ok: false, code: 'unauthorized' })
              }
            }
            expect(fake.calls).toHaveLength(0)
            for (const [method, path] of routes) {
              expect(
                (
                  await request({
                    method,
                    path: prefix + path,
                    peer: remote,
                    headers: { authorization: `Bearer ${token}` },
                    body: method === 'POST' ? {} : undefined,
                  })
                ).status
              ).toBe(200)
            }
            expect(fake.calls).toHaveLength(4)
            expect(
              (await request({ method: 'GET', path: '/v1/mobile/dashboard', peer: remote })).status
            ).toBe(enforce ? 401 : 426)
            expect(
              (await request({ method: 'GET', path: '/v1/mobile/health', peer: remote })).status
            ).toBe(200)
          },
          { jobhunt: fake.config, mobileAuthStore: store }
        )
      })
    })
  }

  test('refused connection is unavailable and POST is explicitly unsubmitted', async () => {
    const fake = fakeJobhunt()
    fake.server.stop(true)
    await withWiredServer(
      async ({ request }) => {
        for (const method of ['GET', 'POST']) {
          const response = await request({
            method,
            path: prefix + (method === 'GET' ? '/triage' : '/leads/x/decision'),
            peer: local,
            body: method === 'POST' ? {} : undefined,
          })
          expect(response.status).toBe(503)
          expect(await response.json()).toMatchObject({
            error: {
              code: 'gateway_jobhunt_unavailable',
              details: method === 'POST' ? { submitted: false } : {},
            },
          })
        }
      },
      { jobhunt: fake.config }
    )
  })

  for (const mode of ['hang', 'drop', 'bad'] as const) {
    test(`${mode}: conservative errors and one attempt per request`, async () => {
      await withFake(async (fake) => {
        await withWiredServer(
          async ({ request }) => {
            // Dropping stops this fake, so exercise its POST first and alone.
            for (const method of mode === 'drop' ? ['POST'] : ['GET', 'POST']) {
              const response = await request({
                method,
                path: prefix + (method === 'GET' ? '/triage' : '/leads/x/ask'),
                peer: local,
                body: method === 'POST' ? {} : undefined,
              })
              expect(response.status).toBe(mode === 'bad' ? 502 : 504)
              expect(await response.json()).toMatchObject({
                error: {
                  code:
                    method === 'POST'
                      ? 'gateway_jobhunt_uncertain'
                      : mode === 'bad'
                        ? 'gateway_jobhunt_bad_response'
                        : 'gateway_jobhunt_timeout',
                  details:
                    method === 'POST'
                      ? { submitted: 'unknown', ...(mode === 'bad' ? { status: 200 } : {}) }
                      : {},
                },
              })
            }
            expect(fake.calls).toHaveLength(mode === 'drop' ? 1 : 2)
          },
          { jobhunt: fake.config }
        )
      }, mode)
    })
  }

  test('only the four fixed paths are exposed and invalid shape never reaches upstream', async () => {
    await withFake(async (fake) => {
      await withWiredServer(
        async ({ request, server }) => {
          expect(
            (await request({ method: 'GET', path: `${prefix}/queue`, peer: local })).status
          ).toBe(404)
          for (const id of ['bad%2Fid', 'bad%20id', 'a'.repeat(129)]) {
            const response = await request({
              method: 'GET',
              path: `${prefix}/leads/${id}`,
              peer: local,
            })
            expect(response.status).toBe(400)
            expect(await response.json()).toMatchObject({ error: { code: 'invalid_request' } })
          }
          for (const [body, status] of [
            ['[]', 400],
            ['null', 400],
            ['oops', 400],
            ['', 400],
            [JSON.stringify({ text: 'é'.repeat(33000) }), 413],
          ] as const) {
            const response = await server.handler(
              new Request(`http://acp.test${prefix}/leads/x/decision`, { method: 'POST', body }),
              { peer: local }
            )
            expect(response.status).toBe(status)
          }
          expect(fake.calls).toHaveLength(0)
        },
        { jobhunt: fake.config }
      )
    })
  })

  test('non-loopback upstream disables forwarding', async () => {
    await withWiredServer(
      async ({ request }) => {
        const response = await request({
          method: 'POST',
          path: `${prefix}/leads/x/decision`,
          body: {},
          peer: local,
        })
        expect(response.status).toBe(503)
        expect(await response.json()).toMatchObject({
          error: { code: 'gateway_jobhunt_unavailable', details: { submitted: false } },
        })
      },
      { jobhunt: { baseUrl: 'http://example.com' } }
    )
  })

  test('redirects are not followed to unapproved paths', async () => {
    await withFake(async (fake) => {
      await withWiredServer(
        async ({ request }) => {
          const response = await request({ method: 'GET', path: `${prefix}/triage`, peer: local })
          expect(response.status).toBe(307)
          expect(await response.text()).toBe(success)
          expect(fake.calls).toHaveLength(1)
        },
        { jobhunt: fake.config }
      )
    }, 'redirect')
  })
})
