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
import type { WorkClient } from '@wrkq/client'

import { createWrkfClientLifecycle } from '../wrkf/client-lifecycle.js'

// ---------------------------------------------------------------------------
// Helpers: minimal fake WorkClient factories for lifecycle unit tests.
// `createClient` runs autoInitialize internally and rejects on handshake
// failure, so a failing factory models the fail-closed path; a resolving
// factory models a live, already-initialized client.
// ---------------------------------------------------------------------------

function failingFactory(): () => Promise<WorkClient> {
  return () => Promise.reject(new Error('wrkf: binary not found or db unreadable'))
}

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
  test('propagates client creation rejection: startup must throw when wrkf fails to init', async () => {
    // Production requirement: if wrkf cannot initialize, acp-server must NOT start.
    // createWrkfClientLifecycle must NOT catch the error and return a half-initialized lifecycle.
    //
    // Simulated scenario: binary missing, db unreadable, protocol handshake failure.
    await expect(
      createWrkfClientLifecycle({
        // Inject a failing factory (test seam) instead of spawning a real binary.
        _createClient: failingFactory(),
        dbPath: '/nonexistent/wrkf.db',
        clientInfo: { name: 'acp-server', version: '0.1.0' },
      })
    ).rejects.toThrow()
  })

  test('returns a live WrkfLifecycle when the client initializes', async () => {
    const lifecycle = await createWrkfClientLifecycle({
      _createClient: succeedingFactory(),
      dbPath: '/tmp/wrkf-test.db',
      clientInfo: { name: 'acp-server', version: '0.1.0' },
    })

    expect(lifecycle).toBeDefined()
    // The returned lifecycle exposes the port adapter
    expect(lifecycle.wrkf).toBeDefined()
    // And provides a close() handle for graceful shutdown
    expect(typeof lifecycle.close).toBe('function')

    // Clean up
    await lifecycle.close()
  })

  test('close() is idempotent and does not throw', async () => {
    const lifecycle = await createWrkfClientLifecycle({
      _createClient: succeedingFactory(),
      dbPath: '/tmp/wrkf-test.db',
      clientInfo: { name: 'acp-server', version: '0.1.0' },
    })

    // Must not reject on double close (graceful teardown path)
    await lifecycle.close()
    await expect(lifecycle.close()).resolves.toBeUndefined()
  })
})

describe('createWrkfClientLifecycle — close on shutdown', () => {
  test('lifecycle.close() calls through to the underlying client close', async () => {
    let closeCalled = false
    const lifecycle = await createWrkfClientLifecycle({
      _createClient: succeedingFactory(() => {
        closeCalled = true
      }),
      dbPath: '/tmp/wrkf-test.db',
      clientInfo: { name: 'acp-server', version: '0.1.0' },
    })

    expect(closeCalled).toBe(false)
    await lifecycle.close()
    expect(closeCalled).toBe(true)
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
