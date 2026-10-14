/**
 * Spec §2: "Tokens never appear in logs, access logs included."
 *
 * The access log is the one place on the request hot path that writes an
 * attacker-readable file, so this pins it directly rather than by inspection.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAccessLogger } from '../src/access-log.js'
import { createMobileAuthStore } from '../src/mobile-auth/store.js'
import { finishRequestLog, startRequestLog } from '../src/request-log.js'

import { withWiredServer } from './fixtures/wired-server.js'

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'acp-access-log-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('access log redaction', () => {
  test('a bearer token and a pairing code never reach the access log', async () => {
    const store = createMobileAuthStore()
    const { code } = store.mintPairingCode()
    const redeemed = store.redeemPairingCode(store.mintPairingCode().code)
    const token = redeemed?.token ?? ''
    store.setEnforce(true)

    const logPath = join(tempDir(), 'access.log')
    const logger = await createAccessLogger(logPath)
    expect(logger).not.toBeNull()

    await withWiredServer(
      async ({ request }) => {
        const calls: Array<{
          method: string
          path: string
          body?: unknown
          headers?: HeadersInit
        }> = [
          {
            method: 'GET',
            path: '/v1/mobile/dashboard',
            headers: { authorization: `Bearer ${token}` },
          },
          // A denied caller must not get its rejected token written down either.
          {
            method: 'GET',
            path: '/v1/mobile/dashboard',
            headers: { authorization: `Bearer ${token}-forged` },
          },
          {
            method: 'POST',
            path: '/v1/mobile/pair',
            body: { pairingCode: code },
          },
        ]

        for (const call of calls) {
          const response = await request({ ...call, peer: { address: '100.73.60.81' } })
          logger?.log({
            request: new Request(`http://acp.test${call.path}`, {
              method: call.method,
              headers: call.headers,
            }),
            response,
            durationMs: 1,
            clientIp: '100.73.60.81',
          })
        }
      },
      { mobileAuthStore: store }
    )

    logger?.close()
    await Bun.sleep(20)

    const contents = readFileSync(logPath, 'utf8')
    expect(contents.length).toBeGreaterThan(0)
    expect(contents).not.toContain(token)
    expect(contents).not.toContain(code)
    expect(contents.toLowerCase()).not.toContain('bearer')
  })

  test('a bearer token and a pairing code never reach the structured request log', async () => {
    const store = createMobileAuthStore()
    const { code } = store.mintPairingCode()
    const redeemed = store.redeemPairingCode(store.mintPairingCode().code)
    const token = redeemed?.token ?? ''
    store.setEnforce(true)

    const lines: string[] = []
    const originalLog = console.log
    const originalError = console.error
    console.log = (...args: unknown[]) => lines.push(args.join(' '))
    console.error = (...args: unknown[]) => lines.push(args.join(' '))
    try {
      await withWiredServer(
        async ({ request }) => {
          const calls = [
            {
              method: 'GET',
              path: `/v1/mobile/dashboard?token=${token}`,
              headers: { authorization: `Bearer ${token}` },
            },
            { method: 'POST', path: '/v1/mobile/pair', body: { pairingCode: code } },
            { method: 'POST', path: '/v1/mobile/pair', body: { pairingCode: `${code}x` } },
          ]
          for (const call of calls) {
            const url = new URL(`http://acp.test${call.path}`)
            const context = startRequestLog(
              new Request(url, { method: call.method }),
              url,
              '100.73.60.81'
            )
            const response = await request({ ...call, peer: { address: '100.73.60.81' } })
            finishRequestLog(context, response)
          }
        },
        { mobileAuthStore: store }
      )
      await Bun.sleep(20)
    } finally {
      console.log = originalLog
      console.error = originalError
    }

    const contents = lines.join('\n')
    expect(lines.filter((line) => line.includes('"event":"http.request"')).length).toBe(3)
    for (const line of lines.filter((entry) => entry.includes('"event":"http.request"'))) {
      expect(JSON.parse(line)).toMatchObject({ component: 'http', event: 'http.request' })
    }
    expect(contents).toContain('"remote":"100.73.60.81"')
    expect(contents).not.toContain(token)
    expect(contents).not.toContain(code)
    expect(contents.toLowerCase()).not.toContain('bearer')
  })
})

describe('request log volume', () => {
  test('successful gateway polls are quiet; a failing poll still logs', () => {
    const lines: string[] = []
    const originalLog = console.log
    console.log = (...args: unknown[]) => lines.push(args.join(' '))
    try {
      for (const [path, status] of [
        ['/v1/admin/system-events', 200],
        ['/v1/gateway/acp-discord-smoke/deliveries/stream', 200],
        ['/v1/gateway/acp-discord-smoke/deliveries/stream', 503],
        ['/v1/admin/agents', 200],
      ] as const) {
        const url = new URL(`http://acp.test${path}?after=1`)
        const context = startRequestLog(new Request(url), url, '127.0.0.1')
        finishRequestLog(context, new Response(null, { status }))
      }
    } finally {
      console.log = originalLog
    }
    expect(lines.map((line) => JSON.parse(line).data)).toEqual([
      expect.objectContaining({
        path: '/v1/gateway/acp-discord-smoke/deliveries/stream',
        status: 503,
      }),
      expect.objectContaining({ path: '/v1/admin/agents', status: 200 }),
    ])
  })
})
