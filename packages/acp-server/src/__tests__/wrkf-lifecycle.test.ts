/**
 * RED TEST — wrkf client lifecycle: startup fail-closed behavior (W1 acceptance gate)
 *
 * Why red: `packages/acp-server/src/wrkf/client-lifecycle.ts` does not exist yet.
 * Bun throws CannotFindModule at file load; all tests below will fail.
 *
 * What larry must create to turn this green:
 *   packages/acp-server/src/wrkf/client-lifecycle.ts
 *
 *   export interface WrkfLifecycleOptions {
 *     /** Path to the wrkf binary (default: WRKF_BIN env or 'wrkf') *\/
 *     command?: string | undefined
 *     /** Path to the wrkf database (WRKF_DB_PATH env) *\/
 *     dbPath: string
 *     clientInfo: { name: string; version: string }
 *   }
 *
 *   export interface WrkfLifecycle {
 *     /** The live, initialized port ready for injection into deps. *\/
 *     wrkf: AcpWrkfWorkflowPort
 *     /** Graceful shutdown — called on server close. *\/
 *     close(): Promise<void>
 *   }
 *
 *   /**
 *    * Spawn the wrkf binary, initialize the JSON-RPC session, and return the
 *    * ready lifecycle handle. THROWS if initialization fails (fail-closed).
 *    * NOTE: WrkfClient.spawn is synchronous; initialize() is async.
 *    *\/
 *   export async function createWrkfClientLifecycle(
 *     opts: WrkfLifecycleOptions
 *   ): Promise<WrkfLifecycle>
 *
 *   AND in cli.ts:
 *   - Call createWrkfClientLifecycle() during startup.
 *   - Propagate the error (do NOT catch-and-continue) → fail-closed.
 *   - Allow ACP_WRKF_DISABLED=1 to skip real spawn (test/local-dev mode).
 *   - Call lifecycle.close() during graceful shutdown.
 */

import { describe, expect, test } from 'bun:test'

// ── RED IMPORT ──────────────────────────────────────────────────────────────
// client-lifecycle.ts does not exist; bun throws CannotFindModule → RED.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error -- wrkf/client-lifecycle.ts does not exist yet (W1 deliverable)
import { createWrkfClientLifecycle } from '../wrkf/client-lifecycle.js'
// @ts-expect-error -- wrkf/port.ts does not exist yet (W1 deliverable)
import type { AcpWrkfWorkflowPort } from '../wrkf/port.js'
// ────────────────────────────────────────────────────────────────────────────

// ---------------------------------------------------------------------------
// Helpers: minimal fake WrkfClient-like objects for lifecycle unit tests.
// These do NOT depend on @wrkf/client being installed — they only rely on
// the protocol shape (spawn-sync + initialize-async + close-async).
// ---------------------------------------------------------------------------

function makeInitializingClient(
  initResult: 'success' | 'failure',
  onClose?: () => void
): { initialize: () => Promise<unknown>; close: () => Promise<void>; kill: () => void } {
  return {
    initialize(): Promise<unknown> {
      if (initResult === 'failure') {
        return Promise.reject(new Error('wrkf: binary not found or db unreadable'))
      }
      return Promise.resolve({ protocolVersion: '1.0', serverInfo: { name: 'wrkf', version: '0.1.0' } })
    },
    close(): Promise<void> {
      onClose?.()
      return Promise.resolve()
    },
    kill(): void {
      onClose?.()
    },
  }
}

// ---------------------------------------------------------------------------

describe('createWrkfClientLifecycle — fail-closed startup', () => {
  test('propagates initialize() rejection: startup must throw when wrkf fails to init', async () => {
    // Production requirement: if wrkf cannot initialize, acp-server must NOT start.
    // createWrkfClientLifecycle must NOT catch the error and return a half-initialized lifecycle.
    //
    // Simulated scenario: binary missing, db unreadable, protocol handshake failure.
    const badClient = makeInitializingClient('failure')

    await expect(
      createWrkfClientLifecycle({
        // Inject a pre-built client (test seam) instead of spawning a real binary.
        _clientOverride: badClient,
        dbPath: '/nonexistent/wrkf.db',
        clientInfo: { name: 'acp-server', version: '0.1.0' },
      })
    ).rejects.toThrow()
  })

  test('returns a live WrkfLifecycle when initialize() succeeds', async () => {
    const goodClient = makeInitializingClient('success')

    const lifecycle = await createWrkfClientLifecycle({
      _clientOverride: goodClient,
      dbPath: '/tmp/wrkf-test.db',
      clientInfo: { name: 'acp-server', version: '0.1.0' },
    })

    expect(lifecycle).toBeDefined()
    // The returned lifecycle exposes the port
    expect(lifecycle.wrkf).toBeDefined()
    // And provides a close() handle for graceful shutdown
    expect(typeof lifecycle.close).toBe('function')

    // Clean up
    await lifecycle.close()
  })

  test('close() is idempotent and does not throw', async () => {
    const goodClient = makeInitializingClient('success')
    const lifecycle = await createWrkfClientLifecycle({
      _clientOverride: goodClient,
      dbPath: '/tmp/wrkf-test.db',
      clientInfo: { name: 'acp-server', version: '0.1.0' },
    })

    // Must not throw on double close (graceful teardown path)
    await lifecycle.close()
    await expect(lifecycle.close()).resolves.not.toThrow()
  })
})

describe('createWrkfClientLifecycle — close on shutdown', () => {
  test('lifecycle.close() calls through to the underlying client close', async () => {
    let closeCalled = false
    const goodClient = makeInitializingClient('success', () => {
      closeCalled = true
    })

    const lifecycle = await createWrkfClientLifecycle({
      _clientOverride: goodClient,
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
