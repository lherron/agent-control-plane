/**
 * Mobile-surface bearer auth matrix — spec §7 phase 1.
 *
 * Covers the §1 gate table over the real router: peer tier × credential state ×
 * route class, for both `/v1` and `/v2` mobile paths, plus the WS upgrade
 * decision (which `cli.ts` takes from the same function this exercises).
 */
import { describe, expect, test } from 'bun:test'

import { createAcpListenerHandlers } from '../src/acp-listener.js'
import { resolveAcpServerDeps } from '../src/deps.js'
import {
  type MobileAuthStore,
  PAIRING_CODE_TTL_MS,
  createMobileAuthStore,
} from '../src/mobile-auth/store.js'

import { type WiredServerFixture, withWiredServer } from './fixtures/wired-server.js'

const LOOPBACK = { address: '127.0.0.1', family: 'IPv4', port: 51234 }
const LOOPBACK_V6 = { address: '::1', family: 'IPv6', port: 51236 }
const TAILSCALE = { address: '100.73.60.81', family: 'IPv4', port: 51235 }

/** A route in the bearer tier that answers deterministically with no deps wired. */
const GUARDED_PATH = '/v1/mobile/dashboard'
const GUARDED_V2_PATH = '/v2/mobile/dashboard'
const UNAUTHORIZED_BODY = { ok: false, code: 'unauthorized' }

function bearer(token: string): HeadersInit {
  return { authorization: `Bearer ${token}` }
}

/** Pair one device and arm enforcement, returning the device's live token. */
function armedStore(): {
  store: MobileAuthStore
  token: string
  deviceId: string
  tokenHash: string
} {
  const store = createMobileAuthStore()
  const redeemed = store.redeemPairingCode(store.mintPairingCode().code, 'test-device')
  if (redeemed === undefined) {
    throw new Error('fixture pairing failed')
  }
  store.setEnforce(true)
  return {
    store,
    token: redeemed.token,
    deviceId: redeemed.device.deviceId,
    tokenHash: redeemed.device.tokenHash,
  }
}

async function withArmedServer<T>(
  run: (fixture: WiredServerFixture, auth: ReturnType<typeof armedStore>) => Promise<T> | T
): Promise<T> {
  const auth = armedStore()
  return withWiredServer((fixture) => run(fixture, auth), { mobileAuthStore: auth.store })
}

describe('dark ship: enforce=false is zero behavior change (spec §4 step 1)', () => {
  test('a tokenless tailnet caller reaches every route class', async () => {
    const store = createMobileAuthStore()
    await withWiredServer(
      async ({ request }) => {
        for (const path of [
          '/v1/mobile/health',
          '/v1/mobile/pairing',
          GUARDED_PATH,
          GUARDED_V2_PATH,
        ]) {
          const response = await request({ method: 'GET', path, peer: TAILSCALE })
          expect(response.status).not.toBe(401)
        }

        // The shipped iOS client pairs with no code today; denying that here
        // would break it on the dark ship rather than at activation.
        const pair = await request({
          method: 'POST',
          path: '/v1/mobile/pair',
          body: {},
          peer: TAILSCALE,
        })
        expect(pair.status).toBe(200)
      },
      { mobileAuthStore: store }
    )
  })

  test('code redemption is honored while dark — issuance is never gated by enforce', async () => {
    const store = createMobileAuthStore()
    const { code } = store.mintPairingCode()
    await withWiredServer(
      async ({ request, json }) => {
        const response = await request({
          method: 'POST',
          path: '/v1/mobile/pair',
          body: { pairingCode: code, deviceName: 'dark-phone' },
          peer: TAILSCALE,
        })
        expect(response.status).toBe(200)
        const body = await json<{ token: string }>(response)
        expect(store.verifyToken(body.token)).toBe(true)
      },
      { mobileAuthStore: store }
    )
  })
})

describe('enforced gate: bearer tier (spec §1 row 3)', () => {
  test('loopback needs no bearer, over IPv4 and IPv6 alike', async () => {
    await withArmedServer(async ({ request }) => {
      for (const peer of [LOOPBACK, LOOPBACK_V6]) {
        const response = await request({ method: 'GET', path: GUARDED_PATH, peer })
        expect(response.status).toBe(426)
      }
    })
  })

  test('a valid bearer admits a tailnet caller, whatever the scheme case', async () => {
    await withArmedServer(async ({ request }, { token }) => {
      for (const authorization of [`Bearer ${token}`, `bearer ${token}`]) {
        const response = await request({
          method: 'GET',
          path: GUARDED_PATH,
          peer: TAILSCALE,
          headers: { authorization },
        })
        expect({ authorization, status: response.status }).toEqual({ authorization, status: 426 })
      }
    })
  })

  test('missing and invalid bearers get byte-identical 401s', async () => {
    await withArmedServer(async ({ request, json }, { token }) => {
      const missing = await request({ method: 'GET', path: GUARDED_PATH, peer: TAILSCALE })
      const invalid = await request({
        method: 'GET',
        path: GUARDED_PATH,
        peer: TAILSCALE,
        headers: bearer(`${token}x`),
      })
      const malformed = await request({
        method: 'GET',
        path: GUARDED_PATH,
        peer: TAILSCALE,
        headers: { authorization: token },
      })
      const otherScheme = await request({
        method: 'GET',
        path: GUARDED_PATH,
        peer: TAILSCALE,
        headers: { authorization: `Basic ${token}` },
      })
      const empty = await request({
        method: 'GET',
        path: GUARDED_PATH,
        peer: TAILSCALE,
        headers: { authorization: 'Bearer ' },
      })
      const blank = await request({
        method: 'GET',
        path: GUARDED_PATH,
        peer: TAILSCALE,
        headers: { authorization: 'Bearer    ' },
      })

      for (const response of [missing, invalid, malformed, otherScheme, empty, blank]) {
        expect(response.status).toBe(401)
        expect(await json(response)).toEqual(UNAUTHORIZED_BODY)
      }
    })
  })

  test('a deviceId or a stored token hash presented as a bearer is refused', async () => {
    await withArmedServer(async ({ request, json }, { deviceId, tokenHash }) => {
      expect(deviceId.length).toBeGreaterThan(0)
      for (const credential of [deviceId, tokenHash]) {
        const response = await request({
          method: 'GET',
          path: GUARDED_PATH,
          peer: TAILSCALE,
          headers: bearer(credential),
        })
        expect(response.status).toBe(401)
        expect(await json(response)).toEqual(UNAUTHORIZED_BODY)
      }
    })
  })

  test('a revoked device is refused', async () => {
    await withArmedServer(async ({ request, json }, { store, token, deviceId }) => {
      expect(
        (
          await request({
            method: 'GET',
            path: GUARDED_PATH,
            peer: TAILSCALE,
            headers: bearer(token),
          })
        ).status
      ).toBe(426)

      store.revokeDevice(deviceId)
      const response = await request({
        method: 'GET',
        path: GUARDED_PATH,
        peer: TAILSCALE,
        headers: bearer(token),
      })
      expect(response.status).toBe(401)
      expect(await json(response)).toEqual(UNAUTHORIZED_BODY)
    })
  })

  test('an unobservable peer is not loopback — the gate fails closed', async () => {
    await withArmedServer(async ({ request, json }, { token }) => {
      const response = await request({ method: 'GET', path: GUARDED_PATH })
      expect(response.status).toBe(401)
      expect(await json(response)).toEqual(UNAUTHORIZED_BODY)

      // ...but a valid bearer still gets in without an observable peer.
      expect(
        (await request({ method: 'GET', path: GUARDED_PATH, headers: bearer(token) })).status
      ).toBe(426)
    })
  })

  test('X-Forwarded-For cannot launder a tailnet caller into the loopback tier', async () => {
    await withArmedServer(async ({ request }) => {
      const response = await request({
        method: 'GET',
        path: GUARDED_PATH,
        peer: TAILSCALE,
        headers: { 'x-forwarded-for': '127.0.0.1', forwarded: 'for=127.0.0.1' },
      })
      expect(response.status).toBe(401)
    })
  })

  test('/v2 and unknown-version mobile routes are gated identically to /v1', async () => {
    // /v2/mobile/sessions is named by spec rev 4 §7; an unknown version fails closed.
    const rows: Array<[path: string, admittedStatus: number | undefined]> = [
      [GUARDED_V2_PATH, 426],
      ['/v2/mobile/sessions', undefined],
      ['/v9/mobile/whatever', undefined],
    ]
    await withArmedServer(async ({ request, json }, { token }) => {
      for (const [path, admittedStatus] of rows) {
        const denied = await request({ method: 'GET', path, peer: TAILSCALE })
        expect({ path, status: denied.status }).toEqual({ path, status: 401 })
        expect(await json(denied)).toEqual(UNAUTHORIZED_BODY)

        const admitted = await request({
          method: 'GET',
          path,
          peer: TAILSCALE,
          headers: bearer(token),
        })
        const local = await request({ method: 'GET', path, peer: LOOPBACK })
        for (const response of [admitted, local]) {
          expect({ path, status: response.status }).not.toEqual({ path, status: 401 })
        }
        if (admittedStatus !== undefined) expect(admitted.status).toBe(admittedStatus)
      }
    })
  })

  test('non-mobile routes never answer the mobile 401 to a tokenless tailnet caller', async () => {
    await withArmedServer(async ({ request }) => {
      for (const path of ['/v1/sessions', '/v1/admin/agents', '/v1/mobile', '/mobile/dashboard']) {
        const response = await request({ method: 'GET', path, peer: TAILSCALE })
        const body = await response.text()
        expect({ path, body }).not.toEqual({ path, body: JSON.stringify(UNAUTHORIZED_BODY) })
        expect({ path, status: response.status }).not.toEqual({ path, status: 401 })
      }
    })
  })

  test('WS upgrade paths take the same decision as HTTP (spec §3)', async () => {
    const wsPaths = [
      '/v1/mobile/dashboard',
      '/v2/mobile/dashboard',
      '/v1/mobile/messages/watch',
      '/v1/mobile/sessions/hsid-1/timeline',
      '/v1/mobile/sessions/hsid-1/diagnostics',
    ]
    await withArmedServer(async (fixture, { token }) => {
      const handlers = createAcpListenerHandlers({
        acpServer: fixture.server,
        deps: resolveAcpServerDeps(fixture.deps),
        handleCapRpc: async () => Response.json({ jsonrpc: '2.0', id: 1, result: {} }),
      })
      const attempt = async (
        pathname: string,
        peer: typeof TAILSCALE | null,
        authorization?: string
      ): Promise<{ status: number | 'upgraded'; body?: unknown }> => {
        let upgraded = false
        const response = await handlers.fetch(
          new Request(`http://acp.test${pathname}`, {
            headers: {
              upgrade: 'websocket',
              connection: 'Upgrade',
              ...(authorization !== undefined ? { authorization } : {}),
            },
          }),
          {
            requestIP: () => peer,
            upgrade: () => {
              upgraded = true
              return true
            },
          }
        )
        if (upgraded) return { status: 'upgraded' }
        if (response === undefined) throw new Error('no response and no upgrade')
        return { status: response.status, body: await response.json() }
      }

      for (const pathname of wsPaths) {
        const refused = { status: 401, body: UNAUTHORIZED_BODY }
        expect({ pathname, ...(await attempt(pathname, TAILSCALE)) }).toEqual({
          pathname,
          ...refused,
        })
        expect({ pathname, ...(await attempt(pathname, null)) }).toEqual({ pathname, ...refused })
        expect({
          pathname,
          ...(await attempt(pathname, TAILSCALE, `Bearer ${token}xyz`)),
        }).toEqual({ pathname, ...refused })
        expect({ pathname, ...(await attempt(pathname, LOOPBACK)) }).toEqual({
          pathname,
          status: 'upgraded',
        })
        expect({ pathname, ...(await attempt(pathname, TAILSCALE, `Bearer ${token}`)) }).toEqual({
          pathname,
          status: 'upgraded',
        })
      }
    })
  })
})

describe('enforced gate: exempt and pair rows (spec §1 rows 1-2)', () => {
  test('health and the pairing descriptor stay open to any peer; the exemption is exact, not a prefix', async () => {
    await withArmedServer(async ({ request, json }) => {
      expect(
        (await request({ method: 'GET', path: '/v1/mobile/health', peer: TAILSCALE })).status
      ).not.toBe(401)
      expect(
        (await request({ method: 'GET', path: '/v1/mobile/pairing', peer: TAILSCALE })).status
      ).toBe(200)

      const extra = await request({
        method: 'GET',
        path: '/v1/mobile/health/extra',
        peer: TAILSCALE,
      })
      expect(extra.status).toBe(401)
      expect(await json(extra)).toEqual(UNAUTHORIZED_BODY)
    })
  })

  test('the descriptor MUST NOT carry a pairing code (spec §2, normative)', async () => {
    await withArmedServer(async ({ request, json }) => {
      const body = await json<Record<string, unknown>>(
        await request({ method: 'GET', path: '/v1/mobile/pairing', peer: TAILSCALE })
      )
      expect(body).not.toHaveProperty('pairingCode')
      expect(JSON.stringify(body)).not.toContain('pairingCode')
    })
  })

  test('a valid code redeems from the tailnet and mints a usable token', async () => {
    await withArmedServer(async ({ request, json }, { store }) => {
      const { code } = store.mintPairingCode()
      const response = await request({
        method: 'POST',
        path: '/v1/mobile/pair',
        body: { pairingCode: code, deviceName: 'lance-iphone' },
        peer: TAILSCALE,
      })
      expect(response.status).toBe(200)

      const body = await json<{ ok: boolean; token: string; deviceId: string }>(response)
      expect(body.ok).toBe(true)
      expect(store.verifyToken(body.token)).toBe(true)

      const admitted = await request({
        method: 'GET',
        path: GUARDED_PATH,
        peer: TAILSCALE,
        headers: bearer(body.token),
      })
      expect(admitted.status).toBe(426)
    })
  })

  test('a bad, replayed, or absent code from the tailnet gets the same 401', async () => {
    await withArmedServer(async ({ request, json }, { store }) => {
      const pair = (body: Record<string, unknown>) =>
        request({ method: 'POST', path: '/v1/mobile/pair', body, peer: TAILSCALE })
      const devices = async () =>
        (
          await json<{ devices: unknown[] }>(
            await request({ method: 'GET', path: '/v1/mobile/auth/devices', peer: LOOPBACK })
          )
        ).devices.length

      // No code outstanding yet.
      const unminted = await pair({ pairingCode: 'AAAAAAAA' })
      expect(unminted.status).toBe(401)
      expect(await json(unminted)).toEqual(UNAUTHORIZED_BODY)

      const { code } = store.mintPairingCode()
      // A typo is refused without burning the live code.
      const wrong = await pair({ pairingCode: 'AAAAAAAA' })
      expect(wrong.status).toBe(401)
      expect(await json(wrong)).toEqual(UNAUTHORIZED_BODY)

      const before = await devices()
      expect((await pair({ pairingCode: code })).status).toBe(200)

      const replayed = await pair({ pairingCode: code })
      expect(replayed.status).toBe(401)
      expect(await json(replayed)).toEqual(UNAUTHORIZED_BODY)
      // Single use: the replay minted no second device.
      expect(await devices()).toBe(before + 1)

      const codeless = await pair({})
      expect(codeless.status).toBe(401)
      expect(await json(codeless)).toEqual(UNAUTHORIZED_BODY)
    })
  })

  test('the codeless no-op ack survives for loopback callers, minting nothing', async () => {
    await withArmedServer(async ({ request, json }, { store }) => {
      const before = store.readPublicState().devices.length
      const response = await request({
        method: 'POST',
        path: '/v1/mobile/pair',
        body: {},
        peer: LOOPBACK,
      })
      expect(response.status).toBe(200)

      const body = await json<Record<string, unknown>>(response)
      expect(body['ok']).toBe(true)
      expect(body).not.toHaveProperty('token')
      expect(store.readPublicState().devices).toHaveLength(before)
    })
  })

  test('a loopback caller may also redeem a code (spec §1 pair row)', async () => {
    await withArmedServer(async ({ request, json }, { store }) => {
      const { code } = store.mintPairingCode()
      const body = await json<{ token: string }>(
        await request({
          method: 'POST',
          path: '/v1/mobile/pair',
          body: { pairingCode: code },
          peer: LOOPBACK,
        })
      )
      expect(store.verifyToken(body.token)).toBe(true)
    })
  })
})

describe('bearer never substitutes for locality', () => {
  test('attach-info keeps its 404 not_local for a tailnet caller holding a valid token', async () => {
    await withArmedServer(async ({ request, json }, { token }) => {
      const response = await request({
        method: 'GET',
        path: '/v1/mobile/sessions/hsid-1/attach-info',
        peer: TAILSCALE,
        headers: bearer(token),
      })
      expect(response.status).toBe(404)
      expect((await json<{ reason: string }>(response)).reason).toBe('not_local')
    })
  })

  test('the auth admin routes refuse a tailnet caller holding a valid token', async () => {
    await withArmedServer(async ({ request, json }, { token }) => {
      const calls = [
        { method: 'POST', path: '/v1/mobile/auth/pairing-code' },
        { method: 'GET', path: '/v1/mobile/auth/devices' },
        { method: 'POST', path: '/v1/mobile/auth/devices/revoke' },
        { method: 'POST', path: '/v1/mobile/auth/enforce' },
      ] as const

      for (const call of calls) {
        const response = await request({ ...call, peer: TAILSCALE, headers: bearer(token) })
        expect(response.status).toBe(404)
        expect((await json<{ code: string }>(response)).code).toBe('not_local')
      }
    })
  })
})

describe('loopback auth admin routes (spec §4 — the server is the only writer)', () => {
  test('mint → redeem → list → revoke round-trips through the routes alone', async () => {
    const store = createMobileAuthStore()
    await withWiredServer(
      async ({ request, json }) => {
        const minted = await json<{ code: string; expiresAt: string }>(
          await request({
            method: 'POST',
            path: '/v1/mobile/auth/pairing-code',
            peer: LOOPBACK,
          })
        )
        expect(minted.code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{8}$/)

        const paired = await json<{ token: string; deviceId: string }>(
          await request({
            method: 'POST',
            path: '/v1/mobile/pair',
            body: { pairingCode: minted.code, deviceName: 'lance-iphone' },
            peer: TAILSCALE,
          })
        )

        const listed = await json<{
          enforce: boolean
          devices: Array<{ deviceId: string; deviceName: string }>
        }>(await request({ method: 'GET', path: '/v1/mobile/auth/devices', peer: LOOPBACK }))
        expect(listed.enforce).toBe(false)
        expect(listed.devices).toEqual([
          {
            deviceId: paired.deviceId,
            deviceName: 'lance-iphone',
            pairedAt: expect.any(String) as unknown as string,
          },
        ])
        // Stored hashes are never rendered back to the operator.
        expect(JSON.stringify(listed)).not.toContain('tokenHash')
        expect(JSON.stringify(listed)).not.toContain(paired.token)

        const revoked = await request({
          method: 'POST',
          path: '/v1/mobile/auth/devices/revoke',
          body: { deviceId: paired.deviceId },
          peer: LOOPBACK,
        })
        expect(revoked.status).toBe(200)
        expect(store.verifyToken(paired.token)).toBe(false)
        const afterRevoke = await json<{ devices: unknown[] }>(
          await request({ method: 'GET', path: '/v1/mobile/auth/devices', peer: LOOPBACK })
        )
        expect(afterRevoke.devices).toEqual([])

        const missing = await request({
          method: 'POST',
          path: '/v1/mobile/auth/devices/revoke',
          body: { deviceId: paired.deviceId },
          peer: LOOPBACK,
        })
        expect(missing.status).toBe(404)
      },
      { mobileAuthStore: store }
    )
  })

  test('enable refuses an empty device list without force, then arms with it (spec §8)', async () => {
    const store = createMobileAuthStore()
    await withWiredServer(
      async ({ request, json }) => {
        const enforce = (body: Record<string, unknown>) =>
          request({ method: 'POST', path: '/v1/mobile/auth/enforce', body, peer: LOOPBACK })

        const refused = await enforce({ enforce: true })
        expect(refused.status).toBe(409)
        expect((await json<{ code: string }>(refused)).code).toBe('empty_device_list')
        expect(store.isEnforcing()).toBe(false)

        const forced = await enforce({ enforce: true, force: true })
        expect(forced.status).toBe(200)
        expect(store.isEnforcing()).toBe(true)

        // Disabling is the emergency rollback and never needs a force.
        expect((await enforce({ enforce: false })).status).toBe(200)
        expect(store.isEnforcing()).toBe(false)
      },
      { mobileAuthStore: store }
    )
  })

  test('enable needs no force once a device is paired', async () => {
    const store = createMobileAuthStore()
    store.redeemPairingCode(store.mintPairingCode().code)
    await withWiredServer(
      async ({ request }) => {
        const response = await request({
          method: 'POST',
          path: '/v1/mobile/auth/enforce',
          body: { enforce: true },
          peer: LOOPBACK,
        })
        expect(response.status).toBe(200)
        expect(store.isEnforcing()).toBe(true)
      },
      { mobileAuthStore: store }
    )
  })

  test('enforce requires an explicit boolean', async () => {
    const store = createMobileAuthStore()
    store.redeemPairingCode(store.mintPairingCode().code)
    await withWiredServer(
      async ({ request, json }) => {
        const response = await request({
          method: 'POST',
          path: '/v1/mobile/auth/enforce',
          body: { enforce: 'yes' },
          peer: LOOPBACK,
        })
        expect(response.status).toBe(400)
        expect(
          await json<{ error: { details?: Record<string, unknown> } }>(response)
        ).toMatchObject({ error: { details: { field: 'enforce' } } })
        expect(store.isEnforcing()).toBe(false)
      },
      { mobileAuthStore: store }
    )
  })

  test('minting a new pairing code voids the previous outstanding one', async () => {
    const store = createMobileAuthStore()
    await withWiredServer(
      async ({ request, json }) => {
        const mint = async () =>
          json<{ code: string }>(
            await request({ method: 'POST', path: '/v1/mobile/auth/pairing-code', peer: LOOPBACK })
          )
        const first = await mint()
        const second = await mint()
        const pair = (pairingCode: string) =>
          request({
            method: 'POST',
            path: '/v1/mobile/pair',
            body: { pairingCode },
            peer: TAILSCALE,
          })

        expect((await pair(first.code)).status).toBe(401)
        expect((await pair(second.code)).status).toBe(200)
      },
      { mobileAuthStore: store }
    )
  })

  test('a pairing code past its TTL is refused and pairs no device', async () => {
    let now = 1_000_000
    const store = createMobileAuthStore({ now: () => now })
    await withWiredServer(
      async ({ request, json }) => {
        const minted = await json<{ code: string; expiresAt: string }>(
          await request({ method: 'POST', path: '/v1/mobile/auth/pairing-code', peer: LOOPBACK })
        )
        expect(Date.parse(minted.expiresAt)).toBe(now + PAIRING_CODE_TTL_MS)

        now += PAIRING_CODE_TTL_MS + 1
        const expired = await request({
          method: 'POST',
          path: '/v1/mobile/pair',
          body: { pairingCode: minted.code },
          peer: TAILSCALE,
        })
        expect(expired.status).toBe(401)
        expect(await json(expired)).toEqual(UNAUTHORIZED_BODY)
        const listed = await json<{ devices: unknown[] }>(
          await request({ method: 'GET', path: '/v1/mobile/auth/devices', peer: LOOPBACK })
        )
        expect(listed.devices).toEqual([])
      },
      { mobileAuthStore: store }
    )
  })

  test('a hand-typed pairing code matches regardless of case and surrounding spaces', async () => {
    const store = createMobileAuthStore()
    await withWiredServer(
      async ({ request, json }) => {
        const minted = await json<{ code: string }>(
          await request({ method: 'POST', path: '/v1/mobile/auth/pairing-code', peer: LOOPBACK })
        )
        const response = await request({
          method: 'POST',
          path: '/v1/mobile/pair',
          body: { pairingCode: ` ${minted.code.toLowerCase()} ` },
          peer: TAILSCALE,
        })
        expect(response.status).toBe(200)
        const body = await json<{ token: string }>(response)
        expect(store.verifyToken(body.token)).toBe(true)
      },
      { mobileAuthStore: store }
    )
  })
})
