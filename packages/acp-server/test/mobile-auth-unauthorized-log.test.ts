/**
 * A refused mobile request logs why, so an operator can tell "this device never paired" from "this device's
 * token is not valid here" without reading a token: `mobile.unauthorized` carries `credential` absent, malformed
 * or invalid, and never the header's value.
 */
import { afterEach, expect, spyOn, test } from 'bun:test'

import { createMobileAuthStore } from '../src/mobile-auth/store.js'
import { withWiredServer } from './fixtures/wired-server.js'

const remote = { address: '100.118.130.15' }
const local = { address: '127.0.0.1' }
const PATH = '/v1/mobile/jobhunt/triage'
const SECRET = 'not-a-real-token-0123456789'

let spy: ReturnType<typeof spyOn> | undefined
afterEach(() => spy?.mockRestore())

function refusals(): Array<Record<string, unknown>> {
  return (spy?.mock.calls ?? [])
    .map((call) => String(call[0]))
    .filter((line) => line.includes('"mobile.unauthorized"'))
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

test('a refusal logs the credential class and the request, never the credential', async () => {
  const store = createMobileAuthStore()
  const token = store.redeemPairingCode(store.mintPairingCode().code)?.token ?? ''
  spy = spyOn(console, 'warn').mockImplementation(() => {})
  await withWiredServer(
    async ({ request }) => {
      for (const headers of [
        {},
        { authorization: `Basic ${SECRET}` },
        { authorization: `Bearer ${SECRET}` },
      ]) {
        const response = await request({ method: 'GET', path: PATH, peer: remote, headers })
        expect(response.status).toBe(401)
        expect(await response.json()).toEqual({ ok: false, code: 'unauthorized' })
      }
      // Allowed requests log nothing: a valid token from the same peer, and a loopback peer.
      await request({
        method: 'GET',
        path: PATH,
        peer: remote,
        headers: { authorization: `Bearer ${token}` },
      })
      await request({ method: 'GET', path: PATH, peer: local })
    },
    { mobileAuthStore: store, jobhunt: { baseUrl: 'http://127.0.0.1:1' } }
  )
  const lines = refusals()
  expect(lines.map((line) => (line['data'] as Record<string, unknown>)['credential'])).toEqual([
    'absent',
    'malformed',
    'invalid',
  ])
  expect(lines[0]).toMatchObject({
    level: 'warn',
    component: 'mobile-auth',
    data: { path: PATH, remote: remote.address },
  })
  expect(JSON.stringify(lines)).not.toContain(SECRET)
})
