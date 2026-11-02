import { expect, test } from 'bun:test'
import type { AcpServerDeps } from '../src/deps.js'
import { withWiredServer } from './fixtures/wired-server.js'

const ROOT = '/v1/admin/reconciler/acp-request-backfill'
const LOCAL = { address: '127.0.0.1' }

test('fixed plan and apply routes invoke only bound capability, never caller actor', async () => {
  const calls: unknown[] = []
  const requestBackfill = {
    plan: async (requestId: string) => {
      calls.push(['plan', requestId])
      return { status: 200, receipt: { requestId }, result: { rows: [] } }
    },
    apply: async (manifest: unknown, expected: string, requestId: string) => {
      calls.push(['apply', manifest, expected, requestId])
      return { status: 200, receipt: { requestId }, result: { written: 0, eventsCreated: 0 } }
    },
  }
  await withWiredServer(
    async (f) => {
      const plan = await f.request({
        method: 'POST',
        path: `${ROOT}/plan`,
        peer: LOCAL,
        body: {},
        headers: { 'x-acp-actor': 'agent:intruder' },
      })
      expect(plan.status).toBe(200)
      const apply = await f.request({
        method: 'POST',
        path: `${ROOT}/apply`,
        peer: LOCAL,
        body: { manifest: { schema: 'reviewed' }, expectedSha256: 'a'.repeat(64) },
      })
      expect(apply.status).toBe(200)
      expect(calls.length).toBe(2)
      expect(calls[0]).toEqual(['plan', expect.any(String)])
      expect(calls[1]).toEqual([
        'apply',
        { schema: 'reviewed' },
        'a'.repeat(64),
        expect.any(String),
      ])
    },
    { requestBackfill } as Partial<AcpServerDeps>
  )
})

test('unknown/remote peers and browser origins refuse before the fixed capability', async () => {
  let called = 0
  const requestBackfill = {
    plan: async () => {
      called++
      return { status: 200 }
    },
  }
  await withWiredServer(
    async (f) => {
      for (const peer of [undefined, { address: '100.73.60.81' }]) {
        const result = await f.request({
          method: 'POST',
          path: `${ROOT}/plan`,
          peer,
          body: {},
          headers: {
            'x-forwarded-for': '127.0.0.1',
            host: 'localhost',
            'x-acp-actor': 'human:mable',
          },
        })
        expect(result.status).toBe(404)
      }
      const origin = await f.request({
        method: 'POST',
        path: `${ROOT}/plan`,
        peer: LOCAL,
        body: {},
        headers: { origin: 'http://localhost' },
      })
      expect(origin.status).toBe(403)
      expect(called).toBe(0)
    },
    { requestBackfill } as Partial<AcpServerDeps>
  )
})

test('exact JSON shapes reject arbitrary client/locator/actor/body/script overrides', async () => {
  await withWiredServer(async (f) => {
    for (const body of [
      { actor: 'agent:acp-reconciler' },
      { locator: 'rpc://elsewhere' },
      { command: ['bun', 'anything'] },
      { body: { rev: 99 } },
    ]) {
      const result = await f.request({ method: 'POST', path: `${ROOT}/plan`, peer: LOCAL, body })
      expect(result.status).toBe(400)
    }
    const text = await f.request({
      method: 'POST',
      path: `${ROOT}/plan`,
      peer: LOCAL,
      body: {},
      headers: { 'content-type': 'text/plain' },
    })
    expect(text.status).toBe(400)
    const unavailable = await f.request({
      method: 'POST',
      path: `${ROOT}/plan`,
      peer: LOCAL,
      body: {},
    })
    expect(unavailable.status).toBe(503)
  })
})
