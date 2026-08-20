/**
 * `acp mobile ...` against the real router (spec §4).
 *
 * The point of these routes is that the CLI never writes `mobile-auth.json` — the
 * server does. So the assertions here are about the round trip through HTTP, and
 * about the locality gate: with no observable socket peer the CLI is refused,
 * exactly as a tailnet caller would be.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createInMemoryWrkqStoreAdapter } from '../../acp-core/test/fixtures/wrkq-store-adapter.js'
import { createAcpServer } from '../../acp-server/src/index.js'
import { createMobileAuthStore } from '../../acp-server/src/mobile-auth/store.js'
import { openCoordinationStore } from '../../coordination-substrate/src/index.js'

import { runMobileCommand } from '../src/commands/mobile.js'

const LOOPBACK = { address: '127.0.0.1', family: 'IPv4', port: 4242 }
const TAILSCALE = { address: '100.73.60.81', family: 'IPv4', port: 4243 }

type Harness = {
  run(args: string[]): Promise<unknown>
  store: ReturnType<typeof createMobileAuthStore>
}

async function withCli<T>(
  run: (harness: Harness & { setPeer(peer: typeof LOOPBACK | undefined): void }) => Promise<T>
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'acp-mobile-cli-'))
  const previousInterfaceDbPath = process.env['ACP_INTERFACE_DB_PATH']
  process.env['ACP_INTERFACE_DB_PATH'] = join(dir, 'interface.db')
  const coordStore = openCoordinationStore(join(dir, 'coordination.db'))
  const store = createMobileAuthStore({ path: join(dir, 'mobile-auth.json') })
  const server = createAcpServer({
    wrkqStore: createInMemoryWrkqStoreAdapter(),
    coordStore,
    mobileAuthStore: store,
  })

  let peer: typeof LOOPBACK | undefined = LOOPBACK
  const fetchImpl = async (
    input: Request | string | URL,
    init?: RequestInit
  ): Promise<Response> => {
    const request =
      input instanceof Request
        ? input
        : new Request(typeof input === 'string' ? input : input.toString(), init)
    return server.handler(request, peer === undefined ? {} : { peer })
  }

  try {
    return await run({
      store,
      setPeer: (next) => {
        peer = next
      },
      run: async (args) => {
        const output = await runMobileCommand([...args, '--json'], { fetchImpl })
        return output.format === 'json' ? output.body : output
      },
    })
  } finally {
    coordStore.close()
    rmSync(dir, { recursive: true, force: true })
    if (previousInterfaceDbPath === undefined) {
      Reflect.deleteProperty(process.env, 'ACP_INTERFACE_DB_PATH')
    } else {
      process.env['ACP_INTERFACE_DB_PATH'] = previousInterfaceDbPath
    }
  }
}

describe('acp mobile', () => {
  test('pairing-code → devices list → devices revoke round-trips through the server', async () => {
    await withCli(async ({ run, store }) => {
      const minted = (await run(['pairing-code'])) as { code: string; expiresAt: string }
      expect(minted.code).toHaveLength(8)
      expect(Date.parse(minted.expiresAt)).toBeGreaterThan(0)

      const paired = store.redeemPairingCode(minted.code, 'lance-iphone')
      expect(paired).toBeDefined()

      const listed = (await run(['devices', 'list'])) as {
        enforce: boolean
        devices: Array<{ deviceId: string; deviceName: string }>
      }
      expect(listed.enforce).toBe(false)
      expect(listed.devices.map((device) => device.deviceName)).toEqual(['lance-iphone'])

      const revoked = (await run([
        'devices',
        'revoke',
        '--device',
        paired?.device.deviceId ?? '',
      ])) as { revoked: { deviceId: string }; devices: unknown[] }
      expect(revoked.revoked.deviceId).toBe(paired?.device.deviceId as string)
      expect(revoked.devices).toEqual([])
      expect(store.verifyToken(paired?.token ?? '')).toBe(false)
    })
  })

  test('auth enable refuses an empty roster with operator guidance, then arms with --force', async () => {
    await withCli(async ({ run, store }) => {
      await expect(run(['auth', 'enable'])).rejects.toThrow(/no paired devices/)
      expect(store.isEnforcing()).toBe(false)

      const forced = (await run(['auth', 'enable', '--force'])) as { enforce: boolean }
      expect(forced.enforce).toBe(true)
      expect(store.isEnforcing()).toBe(true)

      const disabled = (await run(['auth', 'disable'])) as { enforce: boolean }
      expect(disabled.enforce).toBe(false)
      expect(store.isEnforcing()).toBe(false)
    })
  })

  test('auth enable needs no force once a device is paired', async () => {
    await withCli(async ({ run, store }) => {
      const minted = (await run(['pairing-code'])) as { code: string }
      store.redeemPairingCode(minted.code)

      expect((await run(['auth', 'enable'])) as { enforce: boolean }).toMatchObject({
        enforce: true,
      })
      expect((await run(['auth', 'status'])) as { enforce: boolean }).toMatchObject({
        enforce: true,
      })
    })
  })

  test('the admin routes are refused when the socket peer is not loopback', async () => {
    await withCli(async ({ run, setPeer }) => {
      setPeer(TAILSCALE)
      await expect(run(['pairing-code'])).rejects.toThrow()
      await expect(run(['devices', 'list'])).rejects.toThrow()

      // An unobservable peer is not loopback either — the gate fails closed.
      setPeer(undefined)
      await expect(run(['auth', 'status'])).rejects.toThrow()
    })
  })

  test('unknown subcommands are usage errors, not requests', async () => {
    await withCli(async ({ run }) => {
      await expect(run(['auth', 'arm'])).rejects.toThrow(/unknown mobile auth subcommand/)
      await expect(run(['devices', 'wipe'])).rejects.toThrow(/unknown mobile devices subcommand/)
      await expect(run(['nope'])).rejects.toThrow(/unknown mobile subcommand/)
    })
  })
})
