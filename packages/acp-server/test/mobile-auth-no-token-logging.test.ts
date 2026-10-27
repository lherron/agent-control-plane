/**
 * Spec §2: "Tokens never appear in logs, access logs included."
 *
 * The access log is the one place on the request hot path that writes an
 * attacker-readable file, so this pins it directly rather than by inspection.
 * Requests go through the listener's in-process `fetch` (what Bun.serve calls),
 * which writes both the access log and the structured request line.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type AccessLogger, createAccessLogger } from '../src/access-log.js'
import { createAcpListenerHandlers } from '../src/acp-listener.js'
import { resolveAcpServerDeps } from '../src/deps.js'
import { type MobileAuthStore, createMobileAuthStore } from '../src/mobile-auth/store.js'

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

type Call = { method: string; path: string; body?: unknown; headers?: Record<string, string> }

const TAILNET_PEER = { address: '100.73.60.81', family: 'IPv4', port: 51235 }

/** Drive each call through the listener's fetch from a tailnet peer. */
async function throughListener(
  calls: Call[],
  options: { store?: MobileAuthStore; accessLogger?: AccessLogger | null } = {}
): Promise<number[]> {
  return withWiredServer(
    async (fixture) => {
      const handlers = createAcpListenerHandlers({
        acpServer: fixture.server,
        deps: resolveAcpServerDeps(fixture.deps),
        handleCapRpc: async () => Response.json({ jsonrpc: '2.0', id: 1, result: {} }),
        accessLogger: options.accessLogger,
      })
      const statuses: number[] = []
      for (const call of calls) {
        const response = await handlers.fetch(
          new Request(`http://acp.test${call.path}`, {
            method: call.method,
            headers: {
              ...(call.body !== undefined ? { 'content-type': 'application/json' } : {}),
              ...call.headers,
            },
            ...(call.body !== undefined ? { body: JSON.stringify(call.body) } : {}),
          }),
          { requestIP: () => TAILNET_PEER, upgrade: () => false }
        )
        statuses.push(response?.status ?? 0)
      }
      return statuses
    },
    options.store !== undefined ? { mobileAuthStore: options.store } : {}
  )
}

function armedWithCode(): { store: MobileAuthStore; token: string; code: string } {
  const store = createMobileAuthStore()
  const redeemed = store.redeemPairingCode(store.mintPairingCode().code)
  const token = redeemed?.token ?? ''
  store.setEnforce(true)
  const { code } = store.mintPairingCode()
  return { store, token, code }
}

function captureConsole(): { lines: string[]; restore(): void } {
  const lines: string[] = []
  const originalLog = console.log
  const originalError = console.error
  console.log = (...args: unknown[]) => lines.push(args.join(' '))
  console.error = (...args: unknown[]) => lines.push(args.join(' '))
  return {
    lines,
    restore() {
      console.log = originalLog
      console.error = originalError
    },
  }
}

describe('access log redaction', () => {
  test('a bearer token and a pairing code never reach the access log', async () => {
    const { store, token, code } = armedWithCode()
    const logPath = join(tempDir(), 'access.log')
    const logger = await createAccessLogger(logPath)
    expect(logger).not.toBeNull()

    const statuses = await throughListener(
      [
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
        { method: 'POST', path: '/v1/mobile/pair', body: { pairingCode: code } },
      ],
      { store, accessLogger: logger }
    )
    // The token admits, the forgery is refused, and the code redeems: the secrets were live.
    expect(statuses).toEqual([426, 401, 200])

    logger?.close()
    // The write stream flushes asynchronously; wait for all three lines.
    let contents = ''
    for (const deadline = Date.now() + 2000; Date.now() < deadline; await Bun.sleep(10)) {
      contents = existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''
      if (contents.trim().split('\n').length >= 3) break
    }
    expect(contents.trim().split('\n')).toHaveLength(3)
    expect(contents).not.toContain(token)
    expect(contents).not.toContain(code)
    expect(contents.toLowerCase()).not.toContain('bearer')
  })

  test('a bearer token and a pairing code never reach the structured request log', async () => {
    const { store, token, code } = armedWithCode()
    const captured = captureConsole()
    let statuses: number[]
    try {
      statuses = await throughListener(
        [
          {
            method: 'GET',
            path: `/v1/mobile/dashboard?token=${token}`,
            headers: { authorization: `Bearer ${token}` },
          },
          { method: 'POST', path: '/v1/mobile/pair', body: { pairingCode: code } },
          { method: 'POST', path: '/v1/mobile/pair', body: { pairingCode: `${code}x` } },
        ],
        { store }
      )
      await Bun.sleep(20)
    } finally {
      captured.restore()
    }
    expect(statuses).toEqual([426, 200, 401])

    const requestLines = captured.lines.filter((line) => line.includes('"event":"http.request"'))
    expect(requestLines).toHaveLength(3)
    for (const line of requestLines) {
      expect(JSON.parse(line)).toMatchObject({
        component: 'http',
        event: 'http.request',
        data: { remote: '100.73.60.81' },
      })
    }
    const contents = captured.lines.join('\n')
    expect(contents).not.toContain(token)
    expect(contents).not.toContain(code)
    expect(contents.toLowerCase()).not.toContain('bearer')
  })
})

describe('request log volume', () => {
  test('successful gateway polls write no request line; a failing poll and other routes do', async () => {
    const captured = captureConsole()
    let statuses: number[]
    try {
      statuses = await throughListener([
        { method: 'GET', path: '/v1/admin/system-events?after=1' },
        { method: 'GET', path: '/v1/gateway/acp-discord-smoke/deliveries/stream?after=1' },
        { method: 'GET', path: '/v1/gateway/acp-discord-smoke/deliveries/stream?since=bad' },
        { method: 'GET', path: '/v1/admin/agents' },
      ])
      await Bun.sleep(20)
    } finally {
      captured.restore()
    }
    expect(statuses).toEqual([200, 200, 400, 200])
    const logged = captured.lines
      .filter((line) => line.includes('"event":"http.request"'))
      .map((line) => JSON.parse(line).data)
    expect(logged).toEqual([
      expect.objectContaining({
        path: '/v1/gateway/acp-discord-smoke/deliveries/stream',
        route: '/v1/gateway/:gatewayId/deliveries/stream',
        status: 400,
      }),
      expect.objectContaining({ path: '/v1/admin/agents', status: 200 }),
    ])
  })
})
