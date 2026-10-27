import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import { type AcpCapabilityHost, startAcpCapabilityHost } from './index.js'

const hosts: AcpCapabilityHost[] = []
const tempDirs: string[] = []

afterEach(async () => {
  for (const host of hosts.splice(0)) {
    await host.shutdown()
  }
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

describe('acp-capability-host', () => {
  test('self-registers the ACP and PBC provider manifests', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'acp-cap-host-test-'))
    tempDirs.push(dir)
    const host = await startAcpCapabilityHost({
      capabilitiesDir: join(import.meta.dir, '../../..', 'capabilities'),
      socketPath: join(dir, 'cap.sock'),
      catalogStateDir: join(dir, 'catalog'),
      acpBaseUrl: 'http://127.0.0.1:18470',
    })
    hosts.push(host)

    expect(host.registeredProviders).toEqual([
      { id: 'acp', capabilityCount: 31 },
      { id: 'pbc', capabilityCount: 7 },
    ])
    const response = await host.handleHttpJsonRpc(
      new Request('http://127.0.0.1/v1/cap/rpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'cap.provider.list' }),
      })
    )
    const body = (await response.json()) as {
      result?: { providers?: Array<{ id: string }> }
      error?: unknown
    }

    expect(response.status).toBe(200)
    expect(body.error).toBeUndefined()
    expect(body.result?.providers?.map((provider) => provider.id)).toEqual(['acp', 'pbc'])
  })

  test('logs one rpc.request line per cap.sock frame, never the frame itself', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'acp-cap-host-test-'))
    tempDirs.push(dir)
    const socketPath = join(dir, 'cap.sock')
    const host = await startAcpCapabilityHost({
      capabilitiesDir: join(import.meta.dir, '../../..', 'capabilities'),
      socketPath,
      catalogStateDir: join(dir, 'catalog'),
      acpBaseUrl: 'http://127.0.0.1:18470',
    })
    hosts.push(host)

    const lines: Array<{ component: string; event: string; data: Record<string, unknown> }> = []
    const originalLog = console.log
    console.log = (...args: unknown[]) => {
      const text = args.join(' ')
      if (text.includes('"rpc.request"')) lines.push(JSON.parse(text))
    }
    try {
      let received = ''
      const socket = await Bun.connect({
        unix: socketPath,
        socket: {
          data(_socket, data) {
            received += new TextDecoder().decode(data)
          },
        },
      })
      socket.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'cap.provider.list', client: 'cap/0.3.0 (darwin)' })}\n`
      )
      socket.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'cap.provider.describe', params: { provider: 'no.such.cap' } })}\n`
      )
      const deadline = Date.now() + 3000
      while (received.split('\n').length < 3 && Date.now() < deadline) await Bun.sleep(5)
      socket.end()
    } finally {
      console.log = originalLog
    }

    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({ component: 'rpc', event: 'rpc.request' })
    expect(Object.keys(lines[0]?.data ?? {}).sort()).toEqual([
      'client',
      'durationMs',
      'listener',
      'op',
      'outcome',
    ])
    expect(lines[0]?.data).toMatchObject({
      listener: 'cap',
      op: 'cap.provider.list',
      outcome: 'ok',
      client: 'cap/0.3.0',
    })
    expect(lines[1]?.data).toMatchObject({
      listener: 'cap',
      op: 'cap.provider.describe',
      client: 'unknown',
    })
    expect(lines[1]?.data['outcome']).toBe('cap.not_found')
    expect(JSON.stringify(lines)).not.toContain('no.such.cap')
  })
})
