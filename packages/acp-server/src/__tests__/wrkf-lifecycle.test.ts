/**
 * wrkf client lifecycle: startup fail-closed behavior.
 *
 * `createWrkfClientLifecycle` spawns the wrkf binary via `@wrkq/client`'s
 * `createClient` (which runs the `rpc.initialize` handshake automatically) and
 * returns the ready lifecycle handle, OR throws fail-closed if initialization
 * fails. These unit tests inject the client factory (`_createClient`) so they do
 * not depend on a real binary — the factory either rejects (init failure) or
 * resolves a fake `WorkClient` exposing `close`/`kill`.
 */

import { describe, expect, test } from 'bun:test'
import type { CreateClientOptions, WorkClient } from '@wrkq/client'

import { createWrkfClientLifecycle } from '../wrkf/client-lifecycle.js'

// ---------------------------------------------------------------------------
// Helpers: minimal fake WorkClient factories for lifecycle unit tests.
// `createClient` runs autoInitialize internally and rejects on handshake
// failure; a resolving factory models a live, already-initialized client.
// ---------------------------------------------------------------------------

function succeedingFactory(onClose?: () => void): () => Promise<WorkClient> {
  const fake = {
    close(): Promise<void> {
      onClose?.()
      return Promise.resolve()
    },
    kill(): void {
      onClose?.()
    },
  } as unknown as WorkClient
  return () => Promise.resolve(fake)
}

// ---------------------------------------------------------------------------

describe('createWrkfClientLifecycle — fail-closed startup', () => {
  test('passes one dbLocator to the shared client, leaves token environment untouched, and fails closed', async () => {
    const originalToken = process.env['WRKQD_TOKEN']
    const originalTokenFile = process.env['WRKQD_TOKEN_FILE']
    process.env['WRKQD_TOKEN'] = 'inherited-token'
    process.env['WRKQD_TOKEN_FILE'] = '/tmp/inherited-token-file'
    const seen: CreateClientOptions[] = []
    const initializeFailure = new Error('rpc.initialize authentication refused')

    try {
      await expect(
        createWrkfClientLifecycle({
          dbLocator: 'rpc://mini:7171',
          clientInfo: { name: 'acp-server', version: '0.1.0' },
          _createClient: (options) => {
            seen.push(options)
            return Promise.reject(initializeFailure)
          },
        })
      ).rejects.toBe(initializeFailure)

      expect(seen).toHaveLength(1)
      expect(seen[0]?.dbLocator).toBe('rpc://mini:7171')
      expect(seen[0]?.dbPath).toBeUndefined()
      expect(seen[0]?.env).toBeUndefined()
      expect(process.env['WRKQD_TOKEN']).toBe('inherited-token')
      expect(process.env['WRKQD_TOKEN_FILE']).toBe('/tmp/inherited-token-file')
    } finally {
      if (originalToken === undefined) Reflect.deleteProperty(process.env, 'WRKQD_TOKEN')
      else process.env['WRKQD_TOKEN'] = originalToken
      if (originalTokenFile === undefined) Reflect.deleteProperty(process.env, 'WRKQD_TOKEN_FILE')
      else process.env['WRKQD_TOKEN_FILE'] = originalTokenFile
    }
  })

  test('forwards an explicit hook catalog to the shared client', async () => {
    const seen: CreateClientOptions[] = []
    const lifecycle = await createWrkfClientLifecycle({
      dbPath: '/tmp/wrkf-test.db',
      hookCatalogPath: '/tmp/empty-hook-catalog.json',
      clientInfo: { name: 'acp-server', version: '0.1.0' },
      _createClient: (options) => {
        seen.push(options)
        return succeedingFactory()(options)
      },
    })

    expect(seen[0]?.hookCatalogPath).toBe('/tmp/empty-hook-catalog.json')
    await lifecycle.close()
  })

  test('derives both workflow and store adapters from the one initialized client', async () => {
    const calls: string[] = []
    const fakeClient = {
      wrkf: {
        workflow: {
          list: () => {
            calls.push('workflow adapter')
            return Promise.resolve([])
          },
        },
        role: {
          list: () => {
            calls.push('store adapter')
            return Promise.resolve([])
          },
        },
      },
      close: () => Promise.resolve(),
      kill: () => {},
    } as unknown as WorkClient
    const seen: CreateClientOptions[] = []

    const lifecycle = await createWrkfClientLifecycle({
      dbLocator: 'rpc://mini:7171',
      clientInfo: { name: 'acp-server', version: '0.1.0' },
      _createClient: (options) => {
        seen.push(options)
        return Promise.resolve(fakeClient)
      },
    })

    expect(seen).toHaveLength(1)
    expect(seen[0]?.dbLocator).toBe('rpc://mini:7171')
    expect(lifecycle.client).toBe(fakeClient)
    await lifecycle.wrkf?.workflow.list({})
    await lifecycle.store?.roleAssignmentStore.getRoleMap('T-06784')
    expect(calls).toEqual(['workflow adapter', 'store adapter'])

    await lifecycle.close()
  })

  test('pools exact-principal collaboration clients and closes every connection', async () => {
    const seen: CreateClientOptions[] = []
    const closed: string[] = []
    const lifecycle = await createWrkfClientLifecycle({
      dbLocator: 'rpc://mini:7171',
      principalRef: 'agent:acp-server',
      clientInfo: { name: 'acp-server', version: '0.1.0' },
      _createClient: (options) => {
        seen.push(options)
        const principalRef = options.principalRef ?? 'missing'
        return Promise.resolve({
          close: async () => {
            closed.push(principalRef)
          },
          kill: () => {},
        } as unknown as WorkClient)
      },
    })

    const primary = await lifecycle.clientForPrincipal('agent:acp-server')
    const lanceOne = await lifecycle.clientForPrincipal('agent:lance')
    const lanceTwo = await lifecycle.clientForPrincipal('agent:lance')

    expect(primary).toBe(lifecycle.client)
    expect(lanceTwo).toBe(lanceOne)
    expect(seen.map((options) => options.principalRef)).toEqual(['agent:acp-server', 'agent:lance'])
    expect(seen[1]?.dbLocator).toBe('rpc://mini:7171')

    await lifecycle.close()
    expect(closed.sort()).toEqual(['agent:acp-server', 'agent:lance'])
    await expect(lifecycle.clientForPrincipal('agent:mable')).rejects.toThrow(
      'wrkq client lifecycle is closed'
    )
  })

  test('rejects non-principal attribution before opening a collaboration client', async () => {
    const seen: CreateClientOptions[] = []
    const lifecycle = await createWrkfClientLifecycle({
      dbPath: '/tmp/wrkf-test.db',
      clientInfo: { name: 'acp-server', version: '0.1.0' },
      _createClient: (options) => {
        seen.push(options)
        return succeedingFactory()(options)
      },
    })

    await expect(lifecycle.clientForPrincipal('lance')).rejects.toThrow('exact agent:<id>')
    expect(seen).toHaveLength(1)
    await lifecycle.close()
  })
})

describe('createWrkfClientLifecycle — close on shutdown', () => {
  test('lifecycle.close() calls through to the underlying client close', async () => {
    let closeCalls = 0
    const lifecycle = await createWrkfClientLifecycle({
      _createClient: succeedingFactory(() => {
        closeCalls++
      }),
      dbPath: '/tmp/wrkf-test.db',
      clientInfo: { name: 'acp-server', version: '0.1.0' },
    })

    expect(closeCalls).toBe(0)
    await lifecycle.close()
    await lifecycle.close()
    expect(closeCalls).toBe(1)
  })
})

describe('createWrkfClientLifecycle — ACP_WRKF_DISABLED bypass (local-dev / test mode)', () => {
  test('when ACP_WRKF_DISABLED=1, returns a disabled lifecycle without spawning a binary', async () => {
    // In test environments, real wrkf binary may not be present.
    // ACP_WRKF_DISABLED=1 must be the only way to bypass fail-closed behavior.
    // Tests and local dev use deps.wrkf injection (fake via withWiredServer) instead.
    //
    // This test verifies the env escape hatch resolves cleanly.
    const lifecycle = await createWrkfClientLifecycle({
      wrkfDisabled: true, // or resolved from ACP_WRKF_DISABLED env var
      dbPath: '/tmp/wrkf-disabled-test.db',
      clientInfo: { name: 'acp-server', version: '0.1.0' },
    })

    expect(lifecycle).toBeDefined()
    // Disabled lifecycle still exposes a close() handle (no-op)
    expect(typeof lifecycle.close).toBe('function')
    await lifecycle.close()

    // wrkf is undefined in disabled mode — callers must check before using
    expect(lifecycle.wrkf).toBeUndefined()
  })
})
