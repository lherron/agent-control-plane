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
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(JSON.stringify(body)).toContain('acp')
    expect(JSON.stringify(body)).toContain('pbc')
  })
})
